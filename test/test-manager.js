/**
 * test/test-manager.js — the delivery manager's own decision (`utils/manager.js`).
 *
 * This is the only part of the delivery layer that needs a model, so it is the part with the most to
 * prove. What is pinned here is not "did the model say something sensible" — it is the three things
 * that make a model's answer safe to act on:
 *
 *   1. **The call is handed no file tools.** The manager's whole guarantee is that it never sees the code
 *      (docs/delivery-layer.md). The tool set it is given IS the offered menu — no readFile, no writeFile,
 *      no context tools — so the guarantee is a capability and not a sentence in a prompt. The test
 *      asserts the exact tool names the handle received, and that none of them is a file tool.
 *   2. **The menu is closed on both paths.** A decision is made by calling a tool, and the tool carries
 *      the step, the ticket, the option and the patch — so the ids cannot be mistyped. When the model
 *      answers in prose instead (which a local endpoint on this machine does), the reply goes through the
 *      same fail-closed parse and the same gate: an answer that names a step the triage did not offer, a
 *      ticket that does not exist, an option the filter refused, or a patch already judged is refused by
 *      name, with the refusal saying what IS available in the form the caller has to write back. The two
 *      things it does NOT refuse are names the state already holds — a ticket id mangled inside an option
 *      id, and a step name copied as the sentence around it — which are corrected, and the correction is
 *      on the record.
 *   3. **The two claims that need proving are proved against the records.** "I'm done" and "this patch
 *      is safe to accept without a human" are checked, not believed.
 *
 * The two menus are pinned against each other too: `MANAGER_ACTIONS` (decisions) and
 * `DELIVERY_ACTIONS` (pipeline primitives) are deliberately different lists, but a decision with no
 * command behind it is a decision the loop cannot carry out — which is the exact gap that made
 * `open-ticket` a menu entry nothing could execute.
 *
 * No model call, no network. `AI_CLIENT_HOOKS_DIR` is pinned to an empty folder: `managerDecision`
 * fires `pre-manager` around its own turn, and on this machine that hook starts a real container
 * (docs/architecture.md "Pipeline hooks"). A test must not be able to do that.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const harness = require("../harness");
const manager = require("../utils/manager");
const resume = require("../utils/resume");
const { judgeTemperature } = require("../configs/shared");

// Before anything reaches a hook: an empty hooks dir means no `pre-manager`, no container switch.
const HOOKS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "oresuki-empty-hooks-"));
process.env.AI_CLIENT_HOOKS_DIR = HOOKS_DIR;

// ─── Fixtures: the records the manager is allowed to read ─────────────────────

/** A plan line, in the shape `utils/resume.js` produces. */
function stepPlan(over) {
  return {
    step: "glossary",
    action: "run",
    actionName: "wipe-and-cascade",
    reasons: ["volume 02 is missing its glossary"],
    fromVolume: "02",
    cascade: true,
    wipeFirst: [],
    flags: [],
    countsAsIntervention: true,
    finding: "missing-required",
    existingTicket: null,
    escalation: null,
    ...over,
  };
}

/** A plan, in the shape `planResume` produces. */
function planOf(over) {
  return {
    generatedAt: new Date().toISOString(),
    seriesDir: "/fixture/series",
    verdict: "resume",
    headline: "The run stops at glossary volume 02",
    steps: [stepPlan()],
    volumes: [],
    notes: [],
    recurring: [],
    run: "run-1",
    interventionsByStep: { glossary: 1 },
    interventionBudget: 5,
    deliverable: {
      counts: { published: 40, unverified: 0, missing: 0, emptyInSource: 0, total: 40, scoreMedian: 84 },
    },
    ...over,
  };
}

/** A clean plan: every step finished, and the book is published. */
function cleanPlan(over) {
  return planOf({
    verdict: "nothing-to-do",
    headline: "Every step finished what it claims to have, and the deliverable is clean.",
    steps: [stepPlan({ action: "none", actionName: null, cascade: false, countsAsIntervention: false })],
    interventionsByStep: {},
    ...(over || {}),
  });
}

const ALLOWED_OPTION = {
  id: "TCK-1/O1",
  label: "match the aliases inside a term cell, not the whole cell",
  touches: ["utils/prompt.js"],
  cost: "low",
  risk: "low",
  verify: "the carried-forward term rows are counted before and after",
  requiresCodeChange: true,
};

const REFUSED_OPTION = {
  id: "TCK-1/O2",
  label: "turn off the glossary carry-forward guard",
  touches: [".env"],
  cost: "low",
  risk: "high",
  verify: "the finding disappears",
  requiresCodeChange: false,
};

function ticketOf(over) {
  return {
    id: "TCK-1",
    run: "run-1",
    step: "glossary",
    volume: "02",
    finding: "missing-required",
    status: "open",
    question: "Why does the carry-forward gate refuse this volume's glossary?",
    evidence: [{ file: "Test Story(02)/glossary.md.rejected", note: "the gate's account" }],
    tried: [],
    ruledOut: [],
    ...over,
  };
}

function answeredTicket(over) {
  return ticketOf({
    status: "answered",
    diagnosis: {
      cause: "the relevance test compares the whole term cell instead of the aliases inside it",
      options: [ALLOWED_OPTION],
      recommend: ALLOWED_OPTION.id,
      questions: ["Does the volume print the older spelling anywhere in its text?"],
      read: ["utils/prompt.js"],
      at: new Date().toISOString(),
    },
    options: [ALLOWED_OPTION],
    refusedOptions: [{ option: REFUSED_OPTION, because: "disable-carry-forward-guard", escalateTo: "the account owner" }],
    ...over,
  });
}

function patchOf(over) {
  return {
    id: "P-1",
    ticketId: "TCK-1",
    status: "proposed",
    files: ["utils/prompt.js"],
    summary:
      "Compare the alias spellings inside a term cell rather than the whole cell, so a widened row is not read as a deleted entry.",
    why: "the gate called a rename a loss and quarantined a glossary that had grown",
    couldBreak: "a row that genuinely lost a spelling could pass if the same text appears in its Notes",
    expected: ["glossaryTermRows"],
    verify: "the carried-forward term rows are counted before and after",
    warnings: [],
    questions: [],
    ownerNote: "",
    checkVerdict: { accepted: true, passed: ["npm test", "npm run pipeline-loop"], missing: [], failed: [] },
    checks: [
      { id: "npm-test", exitCode: 0 },
      { id: "pipeline-loop", exitCode: 0 },
    ],
    ...over,
  };
}

// ─── The stand-in for the model server ────────────────────────────────────────

/**
 * Stand in for the model around the manager's turn, without standing in for the tool layer.
 *
 * `script` is one entry per manager call: `{ toolCalls: [{ name, input }], text }`. The handle it hands
 * back is a fake, but the TOOLS it runs are the real ones `buildMoveTools` built, executed for real —
 * so the one-move rule, the missing-field rule, and the ids a tool carries are exercised rather than
 * described. A tool name that is not in the set throws the way the provider throws, which is the shape
 * `unknown-move` exists to report.
 *
 * @param {Array<{toolCalls?: Array<{name: string, input?: Object}>, text?: string}>} script
 * @returns {{seen: Array<{cfg: Object, inputs: string[]}>, restore: Function}} - `seen` collects each
 *   handle's config and what it was sent.
 */
function scriptManagerTurn(script) {
  const seen = [];
  const real = harness.createAgentHandle;
  harness.createAgentHandle = async (cfg) => {
    const entry = { cfg, inputs: [] };
    seen.push(entry);
    const step = script.shift();
    if (step === undefined) throw new Error("the script ran out of manager turns");
    return {
      name: cfg.name,
      async sendTurn(input) {
        entry.inputs.push(input);
        const calls = step.toolCalls || [];
        for (const call of calls) {
          const tool = cfg.tools && cfg.tools[call.name];
          if (!tool) throw new Error(`Model tried to call unavailable tool '${call.name}'`);
          await tool.execute(call.input || {});
        }
        return {
          text: step.text || "",
          reasoning: "",
          finishReason: "stop",
          usage: null,
          result: "stop",
          error: null,
          messages: [],
          toolCalls: calls.map((c) => ({ toolName: c.name, input: c.input || {} })),
          chunks: 1,
          offloads: [],
        };
      },
      async close() {},
    };
  };
  return { seen, restore: () => { harness.createAgentHandle = real; } };
}

// ─── 1: the two menus cannot drift ────────────────────────────────────────────

function testTheTwoMenus() {
  const menuNames = new Set(resume.DELIVERY_ACTIONS.map((a) => a.name));

  for (const action of manager.MANAGER_ACTIONS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(manager.ACTION_MENU_ENTRIES, action.name),
      `"${action.name}" is a decision with no stated entry on the pipeline menu — the loop would have no command for it`
    );
    const entries = manager.ACTION_MENU_ENTRIES[action.name];
    for (const name of entries) {
      assert.ok(menuNames.has(name), `${action.name} maps to "${name}", which is not on DELIVERY_ACTIONS`);
      const verdict = resume.actionIsAvailable(name);
      assert.strictEqual(verdict.allowed, true, `${action.name} maps to "${name}", which the menu refuses: ${verdict.why}`);
    }
  }

  // `end` is the one verb with no primitive, and that is a decision rather than an oversight: it runs
  // nothing, and a "finish" command would be a command that claims a result instead of checking one.
  const noPrimitive = manager.MANAGER_ACTIONS.filter((a) => !manager.ACTION_MENU_ENTRIES[a.name].length);
  assert.deepStrictEqual(noPrimitive.map((a) => a.name), ["end"], "only `end` runs no command, and it is proved instead");

  // The vocabulary of decisions is closed the same way the vocabulary of primitives is. Adding a name
  // here is adding a move the loop can carry out, so it is written out one at a time rather than
  // derived — a move nobody thought about is a move nobody approved.
  assert.deepStrictEqual(
    manager.MANAGER_ACTIONS.map((a) => a.name).sort(),
    ["answer", "choose", "diagnose", "end", "escalate", "fix", "judge", "run", "stop-run"],
    "the manager's moves are exactly the nine this module names"
  );

  console.log("  menus: every decision the manager may make has a command behind it, and only `end` runs nothing");
}

// ─── 2: the reply is parsed fail-closed ───────────────────────────────────────

function testParsing() {
  // A real answer reasons in prose first and puts the JSON last. The LAST block wins, for the same
  // reason `utils/devteam.js` takes the last one: a quoted example on the way to the real answer would
  // otherwise become the answer.
  const prose = [
    "Let me think. The glossary is missing at volume 02 and the gate evidence is beside it,",
    "so a re-run reproduces the quarantine. For example:",
    "```json",
    '{ "action": "run", "reason": "example" }',
    "```",
    "But that is the spin. The move is the ticket.",
    "```json",
    '{ "action": "diagnose", "ticket": "TCK-1", "reason": "the gate is the thing I cannot read" }',
    "```",
  ].join("\n");
  const parsed = manager.parseManagerAction(prose);
  assert.ok(parsed.action, parsed.problems.map((p) => p.message).join("; "));
  assert.strictEqual(parsed.action.action, "diagnose");
  assert.strictEqual(parsed.action.ticket, "TCK-1");

  assert.strictEqual(manager.parseManagerAction("I think we should just try again.").action, null);
  assert.ok(manager.parseManagerAction("I think we should just try again.").problems[0].kind);

  // A decision with no stated reason is not reviewable afterwards.
  const noReason = manager.parseManagerAction('```json\n{ "action": "run", "step": "glossary" }\n```');
  assert.strictEqual(noReason.action, null, "every action requires a reason");

  // The fields each action needs are that action's contract.
  const missing = manager.parseManagerAction('```json\n{ "action": "choose", "ticket": "TCK-1", "reason": "x" }\n```');
  assert.strictEqual(missing.action, null, "choose without an option id is not a choice");

  const invented = manager.parseManagerAction('```json\n{ "action": "delete-the-evidence", "reason": "x" }\n```');
  assert.strictEqual(invented.action, null, "a move that is not on the decision menu never reaches validation");

  console.log("  parsing: prose-then-JSON is salvaged, and an incomplete or invented reply is not a decision");
}

// ─── 3: the menu gate ─────────────────────────────────────────────────────────

function testValidation() {
  const plan = planOf();
  const moves = [
    { kind: "run", step: "glossary", actionName: "wipe-and-cascade", label: "run glossary" },
    { kind: "diagnose", ticket: "TCK-1", label: "diagnose TCK-1" },
  ];
  const tickets = [ticketOf()];
  const patches = [];
  const ctx = { moves, tickets, patches, plan };
  const check = (action, kind) => {
    const verdict = manager.validateManagerAction(action, ctx);
    assert.strictEqual(verdict.allowed, false, `should have refused: ${JSON.stringify(action)}`);
    assert.strictEqual(verdict.kind, kind, `${JSON.stringify(action)} → ${verdict.why}`);
    assert.ok(verdict.why.length > 30, `a refusal has to say what IS available: ${verdict.why}`);
  };

  check({ action: "apply-the-patch", reason: "x" }, "unknown-action");
  check({ action: "run", step: "consistency-audit", reason: "x" }, "not-offered");
  check({ action: "diagnose", ticket: "TCK-nope", reason: "x" }, "unknown-ticket");
  check({ action: "answer", ticket: "TCK-nope", answer: "yes", reason: "x" }, "unknown-ticket");
  check({ action: "answer", ticket: "TCK-1", answer: "yes", reason: "x" }, "no-question");
  check({ action: "choose", ticket: "TCK-nope", option: "TCK-1/O1", reason: "x" }, "unknown-ticket");
  check({ action: "choose", ticket: "TCK-1", option: "TCK-1/O1", reason: "x" }, "not-answered");
  check({ action: "fix", ticket: "TCK-1", reason: "x" }, "not-chosen");
  check({ action: "judge", patch: "P-nope", outcome: "accept", reason: "the alias match is the mechanism the gate was refusing" }, "unknown-patch");
  check({ action: "escalate", note: "idk", reason: "x" }, "thin-escalation");
  check({ action: "end", reason: "looks finished" }, "end-not-provable");

  // An option the filter refused is refused again here, by name, with the escalation attached — the
  // door and the filter say the same thing (gotcha 70).
  const answered = [answeredTicket()];
  const banned = manager.validateManagerAction(
    { action: "choose", ticket: "TCK-1", option: REFUSED_OPTION.id, reason: "cheapest" },
    { moves, tickets: answered, patches, plan }
  );
  assert.strictEqual(banned.allowed, false);
  assert.strictEqual(banned.kind, "banned-option");
  assert.ok(banned.why.includes("account owner"), banned.why);

  const unknownOption = manager.validateManagerAction(
    { action: "choose", ticket: "TCK-1", option: "TCK-1/O9", reason: "x" },
    { moves, tickets: answered, patches, plan }
  );
  assert.strictEqual(unknownOption.kind, "unknown-option");
  assert.ok(unknownOption.why.includes(ALLOWED_OPTION.id), "the refusal names the options that ARE allowed");

  // A second diagnosis of the same ticket is the account owner's call (`diagnose.js --reask`).
  const reask = manager.validateManagerAction(
    { action: "diagnose", ticket: "TCK-1", reason: "again" },
    { moves, tickets: answered, patches, plan }
  );
  assert.strictEqual(reask.kind, "already-answered");
  assert.ok(reask.why.includes("--reask"), reask.why);

  // The manager's ANSWER is where the code boundary is checked, not its question (gotcha 74).
  const cited = manager.validateManagerAction(
    { action: "answer", ticket: "TCK-1", answer: "yes — and utils/prompt.js is where it happens", reason: "x" },
    { moves, tickets: answered, patches, plan }
  );
  assert.strictEqual(cited.kind, "cited-forbidden");
  assert.ok(cited.why.includes("utils/prompt.js"), cited.why);

  const honest = manager.validateManagerAction(
    { action: "answer", ticket: "TCK-1", answer: "the volume prints the older spelling twice in chapter 3", reason: "x" },
    { moves, tickets: answered, patches, plan }
  );
  assert.strictEqual(honest.allowed, true, honest.why);

  // Every question is answered exactly once.
  const twice = manager.validateManagerAction(
    { action: "answer", ticket: "TCK-1", answer: "yes", reason: "x" },
    {
      moves,
      tickets: [answeredTicket({ answers: [{ question: answeredTicket().diagnosis.questions[0], answer: "yes", at: "" }] })],
      patches,
      plan,
    }
  );
  assert.strictEqual(twice.kind, "already-answered");

  // WHICH question is answered is part of the decision when the ticket asked more than one:
  // `recordAnswer` matches the team's wording exactly and `diagnose.js` refuses to guess, so a loop
  // that let an ambiguous answer through would spawn a command it knows will exit 2.
  const twoQuestions = answeredTicket({
    diagnosis: {
      cause: "the relevance test compares the whole term cell",
      options: [ALLOWED_OPTION],
      questions: ["Does volume 01 use the older spelling?", "Does volume 02 use it?"],
      read: ["utils/prompt.js"],
      at: "",
    },
  });
  const twoCtx = { moves, tickets: [twoQuestions], patches, plan };
  assert.strictEqual(
    manager.validateManagerAction({ action: "answer", ticket: "TCK-1", answer: "twice", reason: "x" }, twoCtx).kind,
    "question-unnamed"
  );
  const named = manager.validateManagerAction(
    { action: "answer", ticket: "TCK-1", question: "does volume 02 use it", answer: "twice, in chapter 3", reason: "x" },
    twoCtx
  );
  assert.strictEqual(named.allowed, true, named.why);
  assert.strictEqual(named.question, "Does volume 02 use it?", "the team's own wording is what the loop passes on");
  assert.strictEqual(
    manager.validateManagerAction(
      { action: "answer", ticket: "TCK-1", question: "is the glossary stale?", answer: "no", reason: "x" },
      twoCtx
    ).kind,
    "unknown-question"
  );
  const answeredOnce = answeredTicket({
    diagnosis: { cause: "c", options: [], questions: ["Does volume 01 use the older spelling?"], read: [], at: "" },
    answers: [{ question: "Does volume 01 use the older spelling?", answer: "yes", at: "" }],
  });
  assert.strictEqual(
    manager.validateManagerAction(
      { action: "answer", ticket: "TCK-1", question: "does volume 01 use the older spelling", answer: "no actually", reason: "x" },
      { moves, tickets: [answeredOnce], patches, plan }
    ).kind,
    "already-answered",
    "a paraphrase of an answered question is not a second bite at it"
  );

  // The dev team is summoned by CHOOSING an option that needs code, never by describing a fix.
  const chosenCtx = {
    moves,
    tickets: [answeredTicket({ status: "chosen", choice: { optionId: ALLOWED_OPTION.id, reason: "it changes the test" } })],
    patches,
    plan,
  };
  assert.strictEqual(manager.validateManagerAction({ action: "fix", ticket: "TCK-1", reason: "x" }, chosenCtx).allowed, true);
  assert.strictEqual(
    manager.validateManagerAction({ action: "fix", ticket: "TCK-1", reason: "x" }, { ...chosenCtx, patches: [patchOf()] }).kind,
    "patch-exists",
    "one team at a time"
  );
  const noCode = manager.validateManagerAction(
    { action: "fix", ticket: "TCK-1", reason: "x" },
    {
      moves,
      tickets: [answeredTicket({ status: "chosen", choice: { optionId: REFUSED_OPTION.id, reason: "x" }, options: [REFUSED_OPTION] })],
      patches,
      plan,
    }
  );
  assert.strictEqual(noCode.kind, "option-not-code");

  // Judging a patch is about the change, not about the complaint stopping (gotcha 70 again).
  const judgeCtx = { moves, tickets, patches: [patchOf()], plan };
  assert.strictEqual(
    manager.validateManagerAction({ action: "judge", patch: "P-1", outcome: "accept", reason: "volume 15 passes now" }, judgeCtx).kind,
    "unsound-reason"
  );
  assert.strictEqual(
    manager.validateManagerAction(
      { action: "judge", patch: "P-1", outcome: "accept", reason: "it fixes the relevance test so a widened row is not read as a loss" },
      judgeCtx
    ).allowed,
    true
  );
  const judged = manager.validateManagerAction(
    { action: "judge", patch: "P-1", outcome: "accept", reason: "the mechanism is the one the gate was refusing" },
    { moves, tickets, patches: [patchOf({ status: "accepted" })], plan }
  );
  assert.strictEqual(judged.kind, "already-judged");

  // `run` is legal only for the step the triage offered, in the form it offered.
  assert.strictEqual(manager.validateManagerAction({ action: "run", step: "glossary", reason: "unfinished" }, ctx).allowed, true);

  console.log("  menu gate: every illegal move is refused by name, and every refusal names what is available");
}

// ─── 4: a mistyped id, when the rest of the answer names it exactly ───────────

async function testMistypedIds() {
  const tickets = [answeredTicket()];
  const moves = [
    { kind: "choose", ticket: "TCK-1", option: ALLOWED_OPTION.id, label: `choose ${ALLOWED_OPTION.id} on TCK-1` },
  ];
  const ctx = { moves, tickets, patches: [], plan: planOf() };

  // The live shape (2026-10-07): the right option, copied exactly, and the ticket id mangled on the way
  // in — `…2026-10-06T18-27-38-632Z-1` answered as `…2026-10-27-38-632Z-1`. The option id carries the
  // ticket id, so the decision is readable; refusing it threw away a loop whose diagnosis had already
  // cost 7.1M input tokens.
  const mangled = {
    action: "choose",
    ticket: "TCK-delivery-2026-10-27-38-632Z-1",
    option: ALLOWED_OPTION.id,
    reason: "the free check settles what the gate was refusing before anything is spent",
  };
  const fixed = manager.repairTicketReference(mangled, tickets);
  assert.strictEqual(fixed.action.ticket, "TCK-1", "the ticket the answer's own option id names");
  assert.deepStrictEqual(fixed.repaired, { from: mangled.ticket, to: "TCK-1" }, "the repair is reported, not hidden");
  assert.strictEqual(manager.validateManagerAction(fixed.action, ctx).allowed, true, manager.validateManagerAction(fixed.action, ctx).why);

  // It repairs a name the state already contains, and nothing else: when the option names no ticket
  // either, there is nothing to recover and the refusal stands.
  const bothWrong = manager.repairTicketReference(
    { action: "choose", ticket: "TCK-nope", option: "TCK-nope/O1", reason: "x" },
    tickets
  );
  assert.strictEqual(bothWrong.repaired, null, "an id that matches nothing stays unmatched");
  assert.strictEqual(manager.validateManagerAction(bothWrong.action, ctx).kind, "unknown-ticket");

  // An answer that names a REAL ticket and an option belonging to something else is a contradiction,
  // not a transcription slip, and it is refused for the problem it actually has.
  const crossed = manager.repairTicketReference(
    { action: "choose", ticket: "TCK-1", option: "TCK-someother/O1", reason: "x" },
    tickets
  );
  assert.strictEqual(crossed.repaired, null, "a ticket that exists is never rewritten under it");
  assert.strictEqual(manager.validateManagerAction(crossed.action, ctx).kind, "unknown-option");

  // Only `choose` carries the ticket id twice. A `diagnose` has no second field to recover it from.
  assert.strictEqual(
    manager.repairTicketReference({ action: "diagnose", ticket: "TCK-27", reason: "look again" }, tickets).repaired,
    null,
    "no second field, no repair"
  );

  // End to end, on the text path: a model that answers in prose instead of calling a tool. The parse
  // and the gate are the real ones, and the repair is what saves the decision.
  let decision;
  {
    const stub = scriptManagerTurn([{ text: "```json\n" + JSON.stringify(mangled) + "\n```" }]);
    try {
      decision = await manager.managerDecision({ plan: planOf(), moves, tickets, patches: [] });
    } finally {
      stub.restore();
    }
  }
  assert.strictEqual(decision.ok, true, decision.refusal);
  assert.strictEqual(decision.via, "text", "no tool was called, so the reply was read as text");
  assert.strictEqual(decision.action.ticket, "TCK-1", "the loop acts on the corrected id, not the typed one");
  assert.strictEqual(decision.action.option, ALLOWED_OPTION.id);
  assert.ok(
    decision.warnings.some((w) => w.kind === "repaired-ticket-id"),
    `the correction is on the record: ${JSON.stringify(decision.warnings)}`
  );

  // And the reason the tool path exists: the same decision, made by calling the tool. There is no id in
  // the arguments to mistype, so there is nothing to repair — the ticket id and the option id arrive
  // from the menu entry the tool was built from.
  {
    const stub = scriptManagerTurn([
      { toolCalls: [{ name: "move1_choose", input: { reason: "the free check settles what the gate was refusing before anything is spent" } }] },
    ]);
    try {
      decision = await manager.managerDecision({ plan: planOf(), moves, tickets, patches: [] });
    } finally {
      stub.restore();
    }
  }
  assert.strictEqual(decision.ok, true, decision.refusal);
  assert.strictEqual(decision.via, "tool");
  assert.strictEqual(decision.action.ticket, "TCK-1", "the id came from the menu, not from the model");
  assert.strictEqual(decision.action.option, ALLOWED_OPTION.id);
  assert.deepStrictEqual(
    decision.warnings,
    [],
    "a decision that cannot be mistyped has nothing to report: " + JSON.stringify(decision.warnings)
  );

  // On a re-ask, the refusal is put in front of the role with the ids it has to copy.
  const withCorrection = manager.renderManagerBrief({
    plan: planOf(),
    moves,
    tickets,
    patches: [],
    correction: "there is no open ticket TCK-27. Open tickets: TCK-1.",
  });
  assert.ok(withCorrection.includes("previous answer was refused"), withCorrection.slice(0, 300));
  assert.ok(withCorrection.includes("Open tickets: TCK-1"), "the refusal is quoted verbatim");
  assert.ok(
    withCorrection.indexOf("previous answer was refused") < withCorrection.indexOf("## The moves available"),
    "it is read before the menu, not after it"
  );

  console.log("  mistyped ids: a name the state already holds is corrected and reported; a move it does not support is still refused");
}

// ─── 5: "I'm done" is proved, not asserted ───────────────────────────────────

function testEndIsProvable() {
  const clean = manager.endIsProvable({ plan: cleanPlan(), tickets: [], patches: [] });
  assert.strictEqual(clean.provable, true, clean.reasons.join("; "));

  const cases = [
    [{ plan: planOf() }, "the triage's own verdict"],
    [{ plan: null }, "no triage to read"],
    [{ plan: cleanPlan(), tickets: [ticketOf()] }, "ticket"],
    [{ plan: cleanPlan(), patches: [patchOf()] }, "patch"],
    [
      {
        plan: cleanPlan({
          deliverable: { counts: { published: 30, unverified: 3, missing: 2, emptyInSource: 0, total: 35 } },
        }),
      },
      "missing",
    ],
    [
      {
        plan: cleanPlan({
          verdict: "evidence",
          headline: "Unread gate evidence is lying in a volume folder",
        }),
      },
      "evidence",
    ],
  ];
  for (const [args, expect] of cases) {
    const verdict = manager.endIsProvable(args);
    assert.strictEqual(verdict.provable, false, `should not be provable: ${JSON.stringify(args.plan && args.plan.verdict)}`);
    assert.ok(
      verdict.reasons.join(" ").toLowerCase().includes(expect.toLowerCase()),
      `expected "${expect}" in: ${verdict.reasons.join("; ")}`
    );
  }

  // A hole in the BOOK is a fact about the source, not a failure of the run (gotcha 40): a series with
  // an image-only page must still be reportable as finished.
  const holes = manager.endIsProvable({
    plan: cleanPlan({
      deliverable: { counts: { published: 30, unverified: 0, missing: 0, emptyInSource: 4, total: 34 } },
    }),
  });
  assert.strictEqual(holes.provable, true, holes.reasons.join("; "));

  console.log("  end: provable only from the records, and a hole in the book is not a failure of the run");
}

// ─── 6: an unattended accept is the narrowest thing here ──────────────────────

function testAutoAcceptSafety() {
  const safe = manager.safeToAcceptAutomatically(patchOf());
  assert.strictEqual(safe.safe, true, safe.reasons.join("; "));
  assert.ok(safe.notes.length >= 2, "the reasons it WAS safe are printed too: " + safe.notes.join("; "));

  const cases = [
    [patchOf({ checkVerdict: null }), "checks"],
    [patchOf({ checkVerdict: { accepted: false, missing: [], failed: ["npm test"], passed: [] } }), "failed"],
    [patchOf({ checkVerdict: { accepted: false, missing: ["npm run pipeline-loop"], failed: [], passed: [] } }), "never ran"],
    [patchOf({ files: ["utils/tickets.js"] }), "banned"],
    [patchOf({ files: ["../outside.js"] }), "not project source"],
    [patchOf({ files: ["test/fake-workflow.js"] }), "not ordinary code"],
    [patchOf({ files: [] }), "no files"],
    [patchOf({ warnings: [{ message: "the declared file did not change" }] }), "warning"],
    [patchOf({ summary: "fix the thing" }), "summary"],
    [patchOf({ expected: [] }), "signal"],
    [patchOf({ ownerNote: "I believe the guard itself is wrong" }), "ownerNote"],
    [patchOf({ questions: ["which volume?"] }), "question"],
  ];
  for (const [patch, expect] of cases) {
    const verdict = manager.safeToAcceptAutomatically(patch);
    assert.strictEqual(verdict.safe, false, `should NOT be safe to accept unattended: ${JSON.stringify(patch.files || patch.status)}`);
    assert.ok(
      verdict.reasons.join(" ").toLowerCase().includes(expect.toLowerCase()),
      `expected "${expect}" in: ${verdict.reasons.join("; ")}`
    );
  }

  // A measured regression is the last word, even with everything else green.
  const regression = manager.safeToAcceptAutomatically(patchOf(), {
    outcome: "worse",
    regressions: [{ name: "glossaryTermRows", from: 445, to: 431 }],
  });
  assert.strictEqual(regression.safe, false);
  assert.ok(regression.reasons.join(" ").includes("445 → 431"), regression.reasons.join("; "));

  console.log("  auto-accept: ordinary code with green checks and no warning, and nothing else, unattended");
}

// ─── 7: the call itself — the menu as tools, hooked, fail-closed ──────────────

async function testTheCall() {
  const plan = planOf();
  const tickets = [ticketOf()];
  const moves = [
    {
      kind: "run",
      step: "glossary",
      actionName: "wipe-and-cascade",
      countsAsIntervention: true,
      label:
        "run glossary — wipe-and-cascade, from volume 02, cascade, counts against this step's allowance; " +
        "the same sequence then continues with character-voice, style-guide",
    },
    { kind: "diagnose", ticket: "TCK-1", label: "diagnose TCK-1" },
  ];

  const stub = scriptManagerTurn([
    { toolCalls: [{ name: "move2_diagnose", input: { reason: "the gate is the thing I cannot read" } }] },
  ]);
  try {
    const ok = await manager.managerDecision({ plan, moves, tickets, patches: [] });
    assert.strictEqual(ok.ok, true, ok.refusal);
    assert.strictEqual(ok.action.action, "diagnose");
    assert.strictEqual(ok.via, "tool");
    assert.strictEqual(ok.action.ticket, "TCK-1", "the id came from the menu entry, not from the model");

    // The load-bearing one: the manager is handed NO file tools. Not "told not to use them" — not given
    // them. The menu is the entire tool set, and the harness adds nothing to it: the manager role is not
    // in CONTEXT_MANAGED_ROLES, so no context tools either. An agent handle with the fs tools in it
    // would be the code access this role is defined by not having.
    assert.strictEqual(stub.seen.length, 1);
    const cfg = stub.seen[0].cfg;
    assert.deepStrictEqual(
      Object.keys(cfg.tools),
      ["move1_run_glossary", "move2_diagnose"],
      JSON.stringify(Object.keys(cfg.tools))
    );
    for (const banned of ["readFile", "listFiles", "grep", "writeFile", "editFile", "deleteFile", "manage_context", "recall_memory"]) {
      assert.ok(!cfg.tools[banned], `the manager was handed ${banned}: that is the code it may not read`);
    }
    assert.ok(cfg.systemPrompt.includes("You are a CUSTOMER"), "the role is stated where the model reads it");
    assert.ok(cfg.systemPrompt.includes("Call exactly ONE tool"), "the one-move rule is stated to the role it binds");
    assert.ok(cfg.systemPrompt.includes("the source code"), "the boundary is stated to the role that has to respect it");
    assert.strictEqual(cfg.name, "delivery-manager");
    assert.strictEqual(cfg.maxSteps, manager.MANAGER_MAX_STEPS, "a decision turn reads nothing, so it is capped");
    assert.strictEqual(cfg.temperature, judgeTemperature(), "a decision samples like a grader, not like a writer");
    assert.ok(cfg.maxTokens >= 1024, `the reply cap is the manager's own: ${cfg.maxTokens}`);

    // What the state report contains, and what it must not. With no patch in front of the manager there
    // is no legitimate reason for a source path to appear anywhere in what it is shown.
    const brief = stub.seen[0].inputs[0];
    assert.ok(brief.includes("run glossary — wipe-and-cascade"), "the menu it is offered is the menu it must choose from");
    assert.ok(
      brief.includes("move1_run_glossary — run glossary"),
      "every menu line is named by the tool that carries it out: " + brief.slice(-500)
    );
    assert.ok(brief.includes("diagnose TCK-1"), brief.slice(-400));
    assert.ok(brief.includes("Why does the carry-forward gate refuse"), "the ticket's own question is in front of it");
    assert.ok(brief.includes("glossary.md.rejected"), "the evidence the triage actually looked at is citable");
    assert.ok(!brief.includes(".js"), "nothing in what the manager is shown is source code: " + brief.match(/.{0,60}\.js.{0,20}/g));
  } finally {
    stub.restore();
  }

  // One move per decision, enforced by the tool rather than by a sentence in the prompt.
  {
    const s = scriptManagerTurn([
      {
        toolCalls: [
          { name: "move1_run_glossary", input: { reason: "glossary is the earliest unfinished step, and every later volume is built on it" } },
          { name: "move2_diagnose", input: { reason: "and while I am here, ask the team as well" } },
        ],
        text: "I picked up the glossary.",
      },
    ]);
    try {
      const two = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(two.ok, true, two.refusal);
      assert.strictEqual(two.action.action, "run", "the first call is the decision of record");
      assert.ok(two.warnings.some((w) => w.kind === "second-move-refused"), JSON.stringify(two.warnings));
    } finally {
      s.restore();
    }
  }

  // A call that names a real move and forgets the prose the move needs records nothing.
  {
    const s = scriptManagerTurn([{ toolCalls: [{ name: "move1_run_glossary", input: { reason: "   " } }], text: "just run it" }]);
    try {
      const thin = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(thin.ok, false, "a decision with no reason written down is not a decision");
      assert.ok(thin.warnings.some((w) => w.kind === "move-without-reason"), JSON.stringify(thin.warnings));
    } finally {
      s.restore();
    }
  }

  // A tool that is not on the menu: the manager reached for a move this state does not support.
  {
    const s = scriptManagerTurn([{ toolCalls: [{ name: "move9_wipe_everything", input: { reason: "start over" } }] }]);
    try {
      const reached = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(reached.kind, "unknown-move", reached.refusal);
      assert.ok(reached.refusal.includes("run glossary"), "the refusal names the moves it WAS offered: " + reached.refusal);
    } finally {
      s.restore();
    }
  }

  // A turn that called nothing and wrote nothing is reported as that, not as a parse failure.
  {
    const s = scriptManagerTurn([{ text: "" }]);
    try {
      const silent = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(silent.kind, "no-move", silent.refusal);
      assert.ok(silent.refusal.includes("escalate") || silent.refusal.includes("run glossary"), silent.refusal);
    } finally {
      s.restore();
    }
  }

  // The text path is still there, and still fail-closed: a model that answers in prose.
  {
    const s = scriptManagerTurn([{ text: "I would probably just run it again and see." }]);
    try {
      const bad = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.kind, "unparseable");
      assert.strictEqual(bad.via, "text");
      assert.ok(bad.refusal.length > 10, bad.refusal);
    } finally {
      s.restore();
    }
  }

  // A step the state does not support is refused by the gate, and the refusal names the step that IS
  // offered — in the form the caller has to write back, not the sentence around it.
  {
    const s = scriptManagerTurn([{ text: '```json\n{ "action": "run", "step": "polish", "reason": "finish it" }\n```' }]);
    try {
      const offMenu = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(offMenu.ok, false);
      assert.strictEqual(offMenu.kind, "not-offered");
      assert.ok(offMenu.refusal.includes("The run moves are: glossary"), "the refusal names the step that IS offered: " + offMenu.refusal);
    } finally {
      s.restore();
    }
  }

  // The shape that stopped a live run on 2026-10-08: the right move, and the step field filled with the
  // menu's whole sentence because that sentence is the only place the step was written. It is repaired,
  // reported, and acted on.
  {
    const copied = {
      action: "run",
      step: "glossary — wipe-and-cascade, from volume 02, cascade",
      reason: "glossary is the root unfinished step and every later volume is built on it",
    };
    const s = scriptManagerTurn([{ text: "```json\n" + JSON.stringify(copied) + "\n```" }]);
    try {
      const repaired = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(repaired.ok, true, repaired.refusal);
      assert.strictEqual(repaired.action.step, "glossary", "the decision was read against the move the menu offers");
      assert.ok(repaired.warnings.some((w) => w.kind === "repaired-step-name"), JSON.stringify(repaired.warnings));
    } finally {
      s.restore();
    }
  }

  // A call that died is not a decision, and the failure names the most likely cause on this machine.
  {
    const s = scriptManagerTurn([]);
    harness.createAgentHandle = async () => {
      throw new Error("the model returned no content");
    };
    try {
      const dead = await manager.managerDecision({ plan, moves, tickets, patches: [] });
      assert.strictEqual(dead.ok, false);
      assert.strictEqual(dead.kind, "call-failed");
      assert.ok(dead.refusal.includes("model-switch-state"), "the wrong-container suspicion is said out loud: " + dead.refusal);
    } finally {
      s.restore();
    }
  }

  fs.rmSync(HOOKS_DIR, { recursive: true, force: true });
  console.log(
    "  the call: the menu as tools, no file tool in sight, one move per decision, a repaired name on " +
      "the record, and a dead call names the container"
  );
}

// ─── 8: the manager's own reply budget ────────────────────────────────────────

function testMaxTokens() {
  const before = process.env.DELIVERY_MAX_TOKENS;
  try {
    delete process.env.DELIVERY_MAX_TOKENS;
    assert.strictEqual(manager.managerMaxTokens(), 131072, "the documented default");
    process.env.DELIVERY_MAX_TOKENS = "8192";
    assert.strictEqual(manager.managerMaxTokens(), 8192);
    process.env.DELIVERY_MAX_TOKENS = "1";
    assert.strictEqual(manager.managerMaxTokens(), 131072, "a cap below the floor is not a cap, it is a mistake");
    process.env.DELIVERY_MAX_TOKENS = "nonsense";
    assert.strictEqual(manager.managerMaxTokens(), 131072);
  } finally {
    if (before === undefined) delete process.env.DELIVERY_MAX_TOKENS;
    else process.env.DELIVERY_MAX_TOKENS = before;
  }
  console.log("  reply budget: DELIVERY_MAX_TOKENS is read here, and there is no token budget to read");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async function main() {
  testTheTwoMenus();
  testParsing();
  testValidation();
  await testMistypedIds();
  testEndIsProvable();
  testAutoAcceptSafety();
  testMaxTokens();
  await testTheCall();
  console.log("delivery manager: ok");
})().catch((err) => {
  console.error("delivery manager test failed:", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
