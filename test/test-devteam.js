/**
 * test/test-devteam.js — the dev team: the first role in this pipeline that may change the code the
 * pipeline runs, and the rules that stop it from changing the rules.
 *
 * `npm run delivery --mode=act` gives a manager authority over a run without ever letting it read the
 * code (docs/delivery-layer.md). When re-running stops working it opens a ticket, the diagnostics team answers
 * it, the manager chooses an option, and if that option says `requiresCodeChange` a dev team is called
 * in (plan §9 rows 4–5). That role is the mirror image of the manager's: it reads and edits the code,
 * and it never decides whether its own work is good.
 *
 * Nine things are pinned here, and each one is a rule that would otherwise live only in a prompt:
 *
 *   1. **The write boundary has two layers and both are recorded.** The harness gate confines writes to
 *      the project; this module's gate refuses the banned paths inside it and names WHICH rule it hit.
 *      `deleteFile` is refused by the tool set, so a record built from the gate alone reports "the team
 *      never tried" for the case where it tried and the tool set said no (gotcha 8 / gotcha 74).
 *   2. **A refusal is not a lie about the work.** The same collector must NOT report the edit the patch
 *      exists for as a tool-set refusal — this role really is offered `writeFile` and `editFile`.
 *   3. **The proposal is parsed fail-closed**, like `parseAcceptanceReply` and the diagnosis contract.
 *   4. **The turn has no step cap, and its record says how it actually ran.** This role used to get a
 *      cap scaled by what the ticket points at; it no longer has one, and the record therefore reports
 *      the turn's SHAPE (chunks, tool calls, what it set aside, how it ended) instead of a budget it
 *      stayed under (CONTEXT-MANAGEMENT-DESIGN.md §4.1/§4.9).
 *   5. **The tool note says what the role actually has** — five file tools, two memory tools, a working
 *      window it can see, and no shell, so it may not claim it ran the tests. `AGENT_TOOLS_NOTE` is a
 *      promise about writing and is not appended here.
 *   6. **The brief names the folder the turn is about to edit**, so a turn pointed at one tree is not
 *      fingerprinted against another.
 *   7. **A whole dev turn runs for real** against the scripted endpoint: the edit lands on disk, the
 *      banned write and the deletion are recorded, the tree fingerprint reports what actually changed,
 *      and the proposal reaches the patch only through `recordProposal`.
 *   8. **A turn may not start from a tree somebody else already edited**, and a write the proposal does
 *      not name is a refusal rather than a surprise. Both refusals happen without leaving a patch that
 *      looks proposed.
 *   9. **The machine runs the pinned checks**, not the agent, and the patch's status follows what they
 *      actually returned.
 *
 * Every fixture is a throwaway `git init` repo with its own `package.json`, and the ticket/patch records
 * live OUTSIDE it — inside the fixture repo they would be undeclared changes in the very tree the patch
 * is fingerprinted against (gotcha 69).
 */

"use strict";

const assert = require("assert");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Both channels resolve their home through postMortemDir(), which reads POSTMORTEM_DIR at call time.
// Pointing it at a temp folder keeps the real .postmortem/ (and the real series' history) out of the
// picture — and keeps the patch records out of the fixture's working tree. See gotcha 69 / 71.
const TMP = path.join(os.tmpdir(), "oresuki-devteam-test");
process.env.POSTMORTEM_DIR = path.join(TMP, "postmortem");
// The dev team fires `pre-manager` / `post-manager` around its model turn (docs/architecture.md). Hooks are
// per-machine and optional, so a suite that does not pin the hooks directory would let THIS machine's
// `hooks/pre-manager.sh` load a real model during `npm test` (gotcha 22). An empty folder is the
// documented no-op: absent hooks, nothing runs.
process.env.AI_CLIENT_HOOKS_DIR = path.join(TMP, "hooks");
// A suite that pins the context window must pin the output cap with it (gotcha 69): an empty string
// blocks `.env` (dotenv will not overwrite a variable that already exists) while parseInt("") → NaN
// keeps the cap derived from the window this suite means to test.
process.env.AI_CONTEXT_WINDOW = "32000";
process.env.AI_MAX_TOKENS = "";
process.env.RESEARCH_ENABLED = "false";

const { AGENT_TOOLS_NOTE } = require("../configs/shared");
const { turnShapeOf } = require("../utils/agents");
const devteam = require("../utils/devteam");
const diagnostics = require("../utils/diagnostics");
const patches = require("../utils/patches");
const tickets = require("../utils/tickets");
const { DELIVERABLE_SIGNALS } = require("../utils/delivery-verify");
const { startFakeBackend } = require("./fake-backend");

const SERIES = "Owaresuki";
const FIXTURE_ROOT = devteam.ROOT;

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * The stand-in code the dev team edits. `glossary.js` carries the real bug from gotcha 68 in miniature
 * (the relevance test compares the WHOLE term cell, so an alias row can never match), because a scripted
 * `editFile` needs a real `oldString` to match and a fix that means something.
 */
const FIXTURE_FILES = {
  "glossary.js": `// Fixture stand-in for the real glossary.js (gotcha 68).\nfunction termSpans(termCell) {\n  return String(termCell).split("/").map((s) => s.trim()).filter(Boolean);\n}\n\nfunction truncateGlossary(rows, sourceText) {\n  const src = String(sourceText || "");\n  return rows.filter((rowText) => {\n    const cells = rowText.split("|");\n    const termCell = cells[0];\n    return src.includes(termCell);\n  });\n}\n\nmodule.exports = { truncateGlossary, termSpans };\n`,

  "utils/prompt.js": `// Fixture stand-in for the shared truncator.\nfunction selectSectionsByRelevance(sections, sourceText) {\n  return sections.filter((s) => String(sourceText || "").includes(s.heading));\n}\n\nmodule.exports = { selectSectionsByRelevance };\n`,

  // A banned path that really exists, so the gate's refusal is about a file, not about a guess.
  "utils/tickets.js": `// Fixture stand-in for the ticket channel. A patch may not edit this: it is one of the rules that\n// constrain the role editing it.\nmodule.exports = { BANNED_OPTIONS: [] };\n`,

  "system-prompts/glossary.md": `# Glossary amend\n\nIf a new term conflicts with an existing one, reconcile them to a single canonical form and note the\nchange.\n`,

  "AGENTS.md": `# Fixture project\n\nThe carry-forward gate protects the terminology, not the formatting of the rows that held it.\n`,

  // The pinned checks run `npm test` and `npm run pipeline-loop` in THIS folder, so both scripts must
  // exist and must exit fast. `FIXTURE_CHECK_EXIT` is how a scenario makes them fail on purpose.
  "checks/green.js": "process.exit(Number(process.env.FIXTURE_CHECK_EXIT || 0));\n",

  "package.json": `${JSON.stringify(
    {
      name: "oresuki-devteam-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node checks/green.js", "pipeline-loop": "node checks/green.js" },
    },
    null,
    2
  )}\n`,

  // The evidence the ticket cites, under `series/` because `evidenceFootprint` resolves evidence against
  // the tree the turn actually edits.
  [`series/${SERIES}(15)/glossary.md.rejected`]: `| 双ふた花ばの恋物語 | Twin Love Story | also written 双ふた花ばの恋こい物もの語がたり |\n`,
  [`series/${SERIES}(14)/glossary.md`]: `| Term | Rendering | Notes |\n|---|---|---|\n| 双ふた花ばの恋物語 | Twin Love Story | |\n`,
};

function git(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A throwaway repository on `main`, plus a channel folder OUTSIDE it.
 *
 * @param {string} label
 * @returns {{root: string, channel: string, seriesDir: string, ticketPaths: Object, patchPaths: Object}}
 */
function makeFixture(label) {
  const root = path.join(TMP, `${label}-repo`);
  const channel = path.join(TMP, `${label}-channel`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(channel, { recursive: true, force: true });

  for (const [rel, text] of Object.entries(FIXTURE_FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
  }

  git(["init", "-q", "-b", "main"], root);
  // The identity lives in the fixture's own config, so any git call the code makes inherits it.
  git(["config", "user.email", "devteam-fixture@example.invalid"], root);
  git(["config", "user.name", "Devteam Fixture"], root);
  git(["config", "commit.gpgsign", "false"], root);
  git(["add", "--", "."], root);
  git(["commit", "-q", "-m", "fixture base"], root);

  // The records are machine state, not source: keep them out of the tree the patch is judged against.
  process.env.POSTMORTEM_DIR = channel;
  return {
    root,
    channel,
    seriesDir: path.join(root, "series"),
    ticketPaths: tickets.ticketPaths(),
    patchPaths: patches.patchPaths(),
  };
}

function fixtureTicket(extra = {}) {
  return {
    step: "glossary",
    volume: "15",
    finding: "quarantine-present",
    evidence: [
      { file: `${SERIES}(15)/glossary.md.rejected`, note: "the quarantined file holds the reconciled row" },
      { file: `${SERIES}(14)/glossary.md`, note: "the previous volume's baseline names the old spelling" },
    ],
    ruledOut: [
      "the file did not shrink, so this is not a reply cut off mid-write",
      "re-running the step produced the identical quarantine twice",
    ],
    question:
      "Why is volume 15's glossary quarantined when its row count grew? The report says a term was " +
      "dropped, and that term is in the file under a different source-language spelling.",
    ...extra,
  };
}

const GOOD_DIAGNOSIS = {
  cause:
    "The extraction pass is shown a truncated copy of the previous glossary and the relevance test " +
    "compares the whole term cell against the text, so an alias row is dropped from the window, " +
    "re-proposed as new, and reconciled into one row exactly as the amend prompt tells it to. The gate " +
    "then reads only the term columns and calls the reconciled row a deletion.",
  options: [
    {
      label: "Teach the relevance test to read the aliases inside a term cell",
      touches: ["glossary.js truncateGlossary"],
      cost: "medium",
      risk: "a short alias could match text it has nothing to do with",
      verify: "the term-row count in the series glossary and the volume 15 folder listing after a rebuild",
      requiresCodeChange: true,
    },
    {
      label: "Add the old spelling back as a second row",
      touches: [`series/${SERIES}(15)/glossary.md`],
      cost: "free",
      risk: "it manufactures the duplicate the one-canonical-rendering rule exists to prevent",
      verify: "the finding disappears",
    },
  ],
  recommend: "Teach the relevance test to read the aliases inside a term cell — it is the only option that changes the deliverable.",
  questions: [],
  read: ["glossary.js"],
  ownerNote: "The guard reported a real change correctly. It is not the fault.",
};

/**
 * Open the channel the way the real one opens: ticket → diagnosis → the manager's choice. No patch yet:
 * opening a patch is what `workTicket` does, and that is the thing under test.
 *
 * @param {string} label
 * @returns {{fx: Object, ticket: Object, option: Object}}
 */
function openChannel(label) {
  const fx = makeFixture(label);
  const created = tickets.createTicket(fixtureTicket(), fx.ticketPaths);
  assert.ok(!created.error, created.error);
  const answered = tickets.recordDiagnosis(created.ticket.id, GOOD_DIAGNOSIS, fx.ticketPaths);
  assert.ok(!answered.error, answered.error);

  const option = answered.ticket.options.find((o) => o.requiresCodeChange);
  assert.ok(option, "no code-changing option survived the banned-option filter");
  const chosen = tickets.recordChoice(
    created.ticket.id,
    {
      optionId: option.id,
      reason:
        "the glossary grew, so the guard is refusing good work; the fix belongs in how the reference is " +
        "narrowed for the extraction pass",
    },
    fx.ticketPaths
  );
  assert.ok(!chosen.error, chosen.error);
  return { fx, ticket: answered.ticket, option };
}

/** The proposal a competent dev team would hand back. */
function goodProposal(extra = {}) {
  return {
    files: ["glossary.js"],
    summary:
      "truncateGlossary now keeps a row when every alias inside its term cell occurs in the text being " +
      "processed, instead of requiring the whole cell to occur verbatim.",
    why:
      "The relevance test compared the whole term cell against the chapter. An alias row (A / B / C) is " +
      "never a verbatim substring of the chapter, so it was systematically dropped from the window, " +
      "re-proposed as a new term, and reconciled away by the amend pass exactly as its prompt says to.",
    couldBreak:
      "A very short alias could match unrelated text and pull a row into the window that the volume does " +
      "not use, which costs prompt size and nothing else.",
    expected: [
      {
        signal: "glossaryTerms",
        direction: "up",
        why: "alias rows stop disappearing from the window, so fewer existing entries are re-proposed and reconciled away",
      },
    ],
    verify: "the term-row count in the series glossary and the volume 15 folder listing after a rebuild",
    questions: [],
    ownerNote: "",
    ...extra,
  };
}

function proposalText(proposal) {
  return (
    "I located the relevance test, read the file, and changed the comparison to the aliases inside the " +
    "cell. Nothing else moved.\n\n```json\n" +
    JSON.stringify(proposal, null, 2) +
    "\n```\n"
  );
}

/**
 * The two steps `patches.recordProposal` runs, in the same order: read the JSON out of the reply, then
 * hold it against the contract. Split here because they are two different failures — a reply that is not
 * JSON and a reply that is JSON but says nothing usable.
 *
 * @param {Object} proposal
 * @returns {{problems: Object[], warnings: Object[]}}
 */
function judgeProposal(proposal) {
  const parsed = devteam.parseProposalReply(proposalText(proposal));
  if (!parsed.proposal) return { problems: parsed.problems, warnings: [] };
  return patches.validateProposalShape(parsed.proposal);
}

/**
 * The scripted dev team. Steps are counted as the assistant messages already in the history — counting
 * tool messages instead makes the second scripted step unreachable.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.proposal] what the final answer proposes (null = answer with prose only)
 * @param {string[]} [opts.extraWrites] project-relative files the turn writes that it does not declare
 */
function devTeamReply({ proposal = goodProposal(), extraWrites = [] } = {}) {
  return (req) => {
    const steps = req.messages.filter((m) => m.role === "assistant").length;

    if (steps === 0) {
      return {
        text: "Locating the relevance test before changing anything.",
        toolCalls: [
          { name: "readFile", arguments: { filePath: "glossary.js" } },
          { name: "grep", arguments: { pattern: "includes", dirPath: "utils" } },
        ],
      };
    }

    if (steps === 1) {
      return {
        text: "The comparison is the whole cell. Changing it to the aliases inside the cell.",
        toolCalls: [
          {
            name: "editFile",
            arguments: {
              filePath: "glossary.js",
              oldString: "    return src.includes(termCell);",
              newString: "    return termSpans(termCell).every((span) => src.includes(span));",
            },
          },
        ],
      };
    }

    if (steps === 2) {
      // Two attempts the boundary exists to stop: editing the rules that judge the patch, and deleting
      // the evidence the ticket is built on.
      const toolCalls = [
        { name: "writeFile", arguments: { filePath: "utils/tickets.js", content: "module.exports = {};\n" } },
        { name: "deleteFile", arguments: { filePath: `series/${SERIES}(15)/glossary.md.rejected` } },
      ];
      for (const f of extraWrites) {
        toolCalls.push({ name: "writeFile", arguments: { filePath: f, content: "// edited without saying so\n" } });
      }
      return { text: "Checking what else this touches.", toolCalls };
    }

    if (!proposal) {
      return { text: "I read the mechanism and ran out of room before writing the report." };
    }
    return { text: proposalText(proposal) };
  };
}

// ─── 1. The write boundary, both layers ───────────────────────────────────────

/**
 * The gate refuses by RULE, not by vibe, and the tool set is what refuses deletion. A refusal that does
 * not name which rule it hit is indistinguishable from caution (gotcha 71).
 */
async function scenarioTheWriteBoundaryRefusesByRule() {
  const fx = makeFixture("gate");
  const gate = await devteam.patchFsTools({ cwd: fx.root, allowedDirs: [fx.root] });

  assert.deepStrictEqual(
    [...gate.advertised].sort(),
    ["editFile", "grep", "listFiles", "readFile", "writeFile"],
    "the dev team is handed exactly the five tools the note promises"
  );
  assert.ok(!gate.advertised.includes("deleteFile"), "deletion is not offered at all (gotcha 8)");

  // Reads go anywhere: this role has to open the code and the evidence.
  assert.strictEqual(gate.approve({ toolName: "readFile", input: { filePath: "glossary.js" } }), true);
  assert.strictEqual(gate.approve({ toolName: "grep", input: { dirPath: "utils" } }), true);
  // An ordinary edit inside the project is allowed — the false-positive half.
  assert.strictEqual(gate.approve({ toolName: "editFile", input: { filePath: "glossary.js" } }), true);
  // An absolute path the brief itself handed the team is the same file, not a different one.
  assert.strictEqual(gate.approve({ toolName: "writeFile", input: { filePath: path.join(fx.root, "utils/prompt.js") } }), true);

  const refused = [
    ["writeFile", "utils/tickets.js", "constraint-tables"],
    ["writeFile", "utils/patches.js", "constraint-tables"],
    ["editFile", "test/test-patches.js", "constraint-tests"],
    ["writeFile", "hooks/pre-glossary.sh", "edit-hooks"],
    ["writeFile", ".env", "edit-env"],
    ["writeFile", `series/${SERIES}(15)/glossary.md`, "edit-corpus"],
    ["writeFile", `series/${SERIES}(15)/glossary.md.rejected`, "edit-corpus"],
    ["writeFile", "/etc/passwd", "path-outside-project"],
  ];
  for (const [tool, target, rule] of refused) {
    const allowed = gate.approve({ toolName: tool, input: { filePath: target } });
    assert.strictEqual(allowed, false, `${tool} on ${target} should be refused`);
    const last = gate.refusals[gate.refusals.length - 1];
    assert.strictEqual(last.rule, rule, `${target} refused under the wrong rule`);
    assert.ok(/account owner/.test(last.reason), `${target}: a refusal must name the account owner`);
  }

  // Deletion: refused by name, with the reason and the route instead.
  assert.strictEqual(
    gate.approve({ toolName: "deleteFile", input: { filePath: `series/${SERIES}(15)/glossary.md.rejected` } }),
    false
  );
  const deletion = gate.refusals[gate.refusals.length - 1];
  assert.strictEqual(deletion.rule, "delete-file");
  assert.ok(/ownerNote/.test(deletion.reason), "the deletion refusal names the route that does exist");

  assert.strictEqual(gate.refusals.length, refused.length + 1);
}

/**
 * The record has to be honest in both directions: a call the tool set stopped is not "nobody tried", and
 * a call that SUCCEEDED is not a refusal either. The second half is what a dev turn actually does.
 */
async function scenarioBothLayersAreRecorded() {
  const fx = makeFixture("layers");
  const gate = await devteam.patchFsTools({ cwd: fx.root, allowedDirs: [fx.root] });
  gate.approve({ toolName: "writeFile", input: { filePath: "utils/tickets.js" } });

  const toolCalls = [
    // Approved by the gate and offered by the tool set: this is the work, not an attempt.
    { name: "editFile", input: { filePath: "glossary.js" } },
    // Approved by the gate, never offered: the tool set answered first.
    { name: "deleteFile", input: { filePath: `series/${SERIES}(15)/glossary.md.rejected` } },
    // The same call the gate already logged — recorded once, with the layer that actually stopped it.
    { name: "writeFile", input: { filePath: "utils/tickets.js" } },
    { name: "readFile", input: { filePath: "AGENTS.md" } },
  ];

  const attempts = devteam.collectPatchWriteAttempts(gate.refusals, toolCalls, gate.advertised);
  assert.strictEqual(attempts.length, 2, "one gate refusal and one tool-set refusal, no double count");

  const gateLayer = attempts.find((a) => a.path === "utils/tickets.js");
  assert.strictEqual(gateLayer.layer, "the approve gate");
  assert.strictEqual(gateLayer.rule, "constraint-tables");

  const toolLayer = attempts.find((a) => a.tool === "deleteFile");
  assert.strictEqual(toolLayer.layer, "the tool set");
  assert.strictEqual(toolLayer.rule, "delete-file");
  assert.ok(/not offered to this role at all/.test(toolLayer.reason));

  assert.ok(
    !attempts.some((a) => a.path === "glossary.js"),
    "a write the sandbox approved is not reported as a refused attempt"
  );

  // Without the advertised list the collector keeps the read-only role's assumption: every mutating
  // name was refused by the tool set. That is what utils/diagnostics.js relies on.
  const withoutAdvertised = devteam.collectPatchWriteAttempts([], toolCalls);
  assert.deepStrictEqual(
    withoutAdvertised.map((a) => a.tool).sort(),
    ["deleteFile", "editFile", "writeFile"],
    "a role handed only read tools has every mutating call stopped by the tool set"
  );
}

// ─── 2. The proposal contract ─────────────────────────────────────────────────

/** Fail-closed like `parseAcceptanceReply`: a proposal another program cannot read is not a thin proposal. */
async function scenarioTheProposalIsParsedFailClosed() {
  const empty = devteam.parseProposalReply("");
  assert.strictEqual(empty.proposal, null);
  assert.strictEqual(
    empty.problems[0].kind,
    "empty-reply",
    "an answer that is absent is a different fact from an answer that cannot be read, and the message says which"
  );

  const prose = devteam.parseProposalReply("I changed the gate. It should be fine now.");
  assert.strictEqual(prose.proposal, null);
  assert.strictEqual(prose.problems[0].kind, "unparseable");

  // A reply that QUOTES the shape and then answers in it: the last block is the answer.
  const quoted = devteam.parseProposalReply(
    "The shape I was asked for is:\n\n```json\n{\"files\": [], \"summary\": \"the example\"}\n```\n\n" +
      "And here is my actual report:\n\n```json\n" +
      JSON.stringify({ ...goodProposal(), files: ["glossary.js", "utils/prompt.js"] }) +
      "\n```\n"
  );
  assert.ok(quoted.proposal, quoted.problems[0] && quoted.problems[0].message);
  assert.deepStrictEqual(quoted.proposal.files, ["glossary.js", "utils/prompt.js"]);

  // The false-positive half: the proposal a competent team hands back passes the same contract.
  const clean = judgeProposal(goodProposal());
  assert.deepStrictEqual(clean.problems, [], JSON.stringify(clean.problems.map((p) => p.kind)));
  assert.deepStrictEqual(clean.warnings, [], JSON.stringify(clean.warnings.map((w) => w.kind)));

  // A required field missing is a refusal, not a warning. The contract lives in `utils/patches.js` and
  // `parseProposalReply` is only the JSON half, so the test runs the same two steps `recordProposal` runs
  // — parse, then the contract — rather than pretending the parser knows the contract.
  const missing = judgeProposal({ ...goodProposal(), verify: "" });
  assert.ok(missing.problems.some((p) => p.kind === "missing-field" && p.field === "verify"), JSON.stringify(missing.problems));

  // Naming a number nobody measures is refused, because the claim would be uncheckable.
  const invented = judgeProposal({ ...goodProposal(), expected: [{ signal: "termCount", direction: "up", why: "fewer drops" }] });
  const badSignal = invented.problems.find((p) => p.kind === "unknown-signal");
  assert.ok(badSignal, JSON.stringify(invented.problems.map((p) => p.kind)));
  assert.strictEqual(badSignal.signal, "termCount");
  for (const signal of DELIVERABLE_SIGNALS) assert.ok(badSignal.message.includes(signal.name), `the refusal does not name ${signal.name}`);
}

// ─── 3. The turn has no step cap ──────────────────────────────────────────────

/**
 * This role used to get a step cap scaled by what the ticket points at (3 steps per 32 KB page, floor 40,
 * ceiling 160), and the auditor that summons it was capped at 120. Neither cap exists any more, and the
 * point here is that they are GONE rather than merely raised: a patch record that names a ceiling this
 * role does not have states a limit that does not exist, and a reader of `patches.md` would go looking
 * for a number to raise when there is nothing to raise.
 *
 * What replaced the cap is not "no wall". The turn runs in CHUNKS, and between chunks the harness moves
 * the chunk's old read answers to disk instead of throwing them away, so a long turn keeps its reading
 * instead of paying to rediscover it (`utils/context.js`, CONTEXT-MANAGEMENT-DESIGN.md §4.1/§4.9). What
 * stops a turn that is going nowhere is the repetition detector and a loose turn clock — both named in
 * the note this role reads. So the record of a turn is now its SHAPE: how many pieces of work it needed,
 * how much of its reading it had to set aside, and the harness's own word for how it ended.
 */
async function scenarioTheDevTurnHasNoStepCap() {
  // Gone, not hidden behind a bigger number. Neither role names a cap any more.
  const capNames = ["devteamMaxStepsFor", "DEVTEAM_STEP_CAP_CEILING", "STEP_CAP_PAGE_BYTES"];
  for (const [who, mod] of [["the dev team", devteam], ["the diagnostics team", diagnostics]]) {
    for (const name of [...capNames, "diagnosticsMaxStepsFor", "DIAGNOSIS_STEP_CAP_CEILING"]) {
      assert.strictEqual(name in mod, false, `${who} must not still carry ${name} — the turn has no cap`);
    }
  }

  // And the role is TOLD what stands in the cap's place, in the note it reads before it reads anything.
  const note = devteam.DEVTEAM_TOOLS_NOTE;
  assert.ok(note.includes("working window"), "the note names the window the turn can see filling up");
  assert.ok(/repeat/i.test(note), "the note names repeating itself as one of the two walls");
  assert.ok(/manage_context/.test(note) && /recall_memory/.test(note), "the note names the two memory tools");

  // The record that replaced "the cap it ran under". `endedAs` is the harness's own word, kept verbatim:
  // a record must not be able to soften "stopped" into "finished", and a turn that never handed a result
  // back records nothing rather than a row of zeroes that reads like it made no tool calls.
  const shape = turnShapeOf({
    chunks: 3,
    toolCalls: [{}, {}, {}],
    offloads: [{ tokensBefore: 500, tokensAfter: 200 }, { tokensBefore: 400, tokensAfter: 100 }],
    compactions: 0,
    result: "stopped",
  });
  assert.deepStrictEqual(
    shape,
    { chunks: 3, toolCalls: 3, offloads: 2, offloadedTokens: 600, compactions: 0, endedAs: "stopped" },
    JSON.stringify(shape)
  );
  assert.strictEqual(turnShapeOf({ chunks: 1, toolCalls: [], result: "max_steps" }).endedAs, "max_steps");
  assert.deepStrictEqual(
    turnShapeOf(null),
    { chunks: 0, toolCalls: 0, offloads: 0, offloadedTokens: 0, compactions: 0, endedAs: null },
    "a turn that died before the harness handed a result back records nothing"
  );
}

// ─── 4. The tool note ─────────────────────────────────────────────────────────

/**
 * `AGENT_TOOLS_NOTE` promises five tools and demands writing. For this role the demand is fine and the
 * silence is not: it has no shell, so a prompt that never says so produces a turn that spends capped
 * steps discovering it, and a proposal that claims it ran the tests (gotcha 8 / gotcha 74).
 */
async function scenarioTheToolNoteSaysWhatTheRoleHas() {
  const note = devteam.DEVTEAM_TOOLS_NOTE;

  assert.ok(note.includes("oldString"), "the argument name a model gets wrong (gotcha 60)");
  assert.ok(
    !/editFile\([^)]*oldText/.test(note),
    "it is never told to USE the wrong argument name — naming `oldText` only to say it does not exist is the gotcha-60 fix"
  );
  assert.ok(note.includes("NO shell"), "no shell, so it may not claim it ran the checks");
  assert.ok(note.includes("npm test") && note.includes("must not claim"), "the claim is refused in the prompt too");
  assert.ok(note.includes("no `deleteFile`"), "deletion is named as absent, so the turn does not hunt for it");
  assert.ok(
    note.includes("FOLDER") && note.includes("filename ENDING") && note.includes('not `"*.md"`'),
    "the grep contract (gotcha 60): a FOLDER where a model passes a file, and a filename ENDING where it writes a wildcard"
  );

  // The two memory tools the harness adds for this role, and the window it can see filling up. A role
  // with no step limit has to be TOLD what replaced the limit, or it behaves as if nothing did.
  assert.ok(
    note.includes("five file tools and two memory tools"),
    "the note counts what the role really has, including the memory tools the harness adds"
  );
  assert.ok(
    note.includes("manage_context") && note.includes("recall_memory"),
    "both memory tools are named with their arguments, not hinted at"
  );
  assert.ok(
    note.includes("## Your working window"),
    "the note names the thing that DOES run out — how much text the turn can hold at once"
  );
  assert.ok(
    /\|\s*working window:\s*[\d,]+ \/ [\d,]+ tokens \(\d+%\)/.test(note),
    "the note shows the shape of the line every tool answer ends with, so the turn recognises it"
  );
  assert.ok(
    note.includes("no step limit"),
    "the turn is told the cap is gone, so it does not spend the turn reasoning about a budget that does not exist (gotcha 8's shape)"
  );
  assert.ok(
    note.includes("Setting a read aside is not forgetting it"),
    "setting text aside is not the same as losing it, and the note says so where the agent would otherwise assume it"
  );
  assert.ok(
    note.includes("Your own edits are never set aside"),
    "a dev turn must know its own changes stay in front of it — the write side is never moved to disk"
  );
  assert.ok(note.includes("## How to finish"), "the work-in-one-pass instruction survived the rewrite");

  for (const banned of [
    "utils/tickets.js",
    "utils/resume.js",
    "utils/delivery-verify.js",
    "utils/ledger.js",
    "utils/runlock.js",
    "utils/patches.js",
    "test/test-patches.js",
    "hooks/",
    ".env",
    ".postmortem/",
    ".rejected",
  ]) {
    assert.ok(note.includes(banned), `the note must name ${banned} as refused`);
  }
  assert.ok(note.includes("ownerNote"), "the route that does exist for a banned file");

  // Every signal the acceptance test measures, so the team cannot invent its own scoreboard. The list is
  // read from the same table `recordProposal` checks the claim against (`patches.SIGNAL_NAMES`), so the
  // prompt and the contract cannot drift apart (the three-step-lists rule, gotcha 67).
  for (const signal of DELIVERABLE_SIGNALS) {
    assert.ok(note.includes(signal.name), `the note omits signal ${signal.name}`);
  }
  assert.strictEqual(DELIVERABLE_SIGNALS.length, 18);
  assert.strictEqual(patches.SIGNAL_NAMES.length, DELIVERABLE_SIGNALS.length, "the prompt's list and the contract's list are the same list");

  // The composed system prompt: the role's own brief plus the role's own note, and NOT the shared one.
  const composed = devteam.loadSystemPrompt() + note;
  assert.ok(composed.includes("NO shell"));
  for (const phrase of [
    "Your working folder is the volume folder",
    "always use writeFile to **overwrite**",
    "You MUST write your output using writeFile or editFile",
  ]) {
    assert.ok(!composed.includes(phrase), `AGENT_TOOLS_NOTE leaked into the dev team's brief: "${phrase}"`);
  }
  assert.ok(AGENT_TOOLS_NOTE.includes("You MUST write your output using writeFile or editFile"));
}

// ─── 5. The brief ─────────────────────────────────────────────────────────────

/** The brief is the ticket, and it names the folder the turn is about to edit. */
async function scenarioTheBriefCarriesTheTicketAndNamesTheTree() {
  const { fx, ticket, option } = openChannel("brief");
  const opened = patches.createPatch({
    ticketId: ticket.id,
    paths: fx.patchPaths,
    ticketsFile: fx.ticketPaths.json,
  });
  assert.ok(opened.patch, opened.error);

  const brief = devteam.renderTicketForDev({
    ticket,
    patch: opened.patch,
    option,
    seriesDir: fx.seriesDir,
    root: fx.root,
  });

  assert.ok(brief.includes(ticket.diagnosis.cause), "the cause the diagnostics team produced");
  assert.ok(brief.includes("**Why the manager chose it:**"), "the manager's reason, so the team implements THAT option");
  assert.ok(brief.includes(option.label));
  assert.ok(brief.includes(ticket.ruledOut[1]), "what was ruled out, so the team does not re-try it");
  assert.ok(brief.includes(ticket.question));
  assert.ok(brief.includes(`${SERIES}(15)/glossary.md.rejected`), "the evidence at the paths the triage named");
  assert.ok(brief.includes("*(nothing recorded)*"), "an empty 'already tried' list is said, not hidden");

  // The root it was GIVEN, not a hardcoded folder: a turn pointed at one tree must not be told about
  // another one while a different tree is fingerprinted.
  assert.ok(brief.includes(`The project root (where the code you may change lives) is\n\`${fx.root}\``));
  assert.ok(brief.includes(fx.seriesDir));
  assert.ok(!brief.includes(`\`${FIXTURE_ROOT}\``), "the brief does not name the real project behind the team's back");
  assert.ok(brief.includes("do not edit them"), "generated output is read-only even for the role that edits code");
}

// ─── 6. A whole dev turn, for real ────────────────────────────────────────────

/**
 * The real harness, the real agent loop, the real file tools and the real approve gate, with a scripted
 * endpoint instead of a model. This is the only way to prove the gate is the one standing in the way.
 */
async function scenarioAWholeDevTurnRunsForReal() {
  const { fx, ticket, option } = openChannel("turn");
  const backend = await startFakeBackend({ model: "stub", reply: devTeamReply() });
  backend.pointEnvAt();

  try {
    const result = await devteam.workTicket({
      ticketId: ticket.id,
      seriesDir: fx.seriesDir,
      root: fx.root,
      patchPaths: fx.patchPaths,
      ticketsFile: fx.ticketPaths.json,
    });

    assert.ok(result.ok, result.error);
    assert.ok(result.patch, "a patch record exists");
    assert.strictEqual(result.patch.status, "proposed");
    assert.strictEqual(result.patch.ticketId, ticket.id);
    assert.strictEqual(result.patch.optionId, option.id, "the patch is bound to the option the manager chose");
    assert.ok(result.turnShape, "the turn records how it ran, because it has no cap to record against");
    assert.strictEqual(result.turnShape.chunks, 1, "this turn fits in one chunk — the scripted answer needs four steps");
    assert.ok(result.turnShape.toolCalls >= 3, "the reads and the edit are counted");
    assert.strictEqual(result.turnShape.offloads, 0, "nothing had to be set aside on a turn this short");
    assert.strictEqual(result.turnShape.endedAs, "complete", "the harness's own word for the ending, kept verbatim");
    assert.ok(result.usage, "the turn's token usage is stored with the proposal it produced");
    assert.deepStrictEqual(result.problems, [], result.problems[0] && result.problems[0].message);
    assert.deepStrictEqual(result.warnings, [], "a legitimate proposal is not flagged (the false-positive half)");

    // The edit landed on disk, in the fixture, and nowhere else.
    const edited = fs.readFileSync(path.join(fx.root, "glossary.js"), "utf8");
    assert.ok(edited.includes("termSpans(termCell).every((span) => src.includes(span))"), edited);
    assert.deepStrictEqual(result.actualChanges, ["glossary.js"], "the tree fingerprint reports the real change");
    assert.strictEqual(patches.workingTreeChanges(fx.root).files.length, 1);

    // The two attempts the boundary exists to stop are recorded, with the layer that stopped each.
    const banned = result.writeAttempts.find((a) => a.path === "utils/tickets.js");
    assert.ok(banned, "the banned write is recorded");
    assert.strictEqual(banned.rule, "constraint-tables");
    assert.strictEqual(banned.layer, "the approve gate");
    const deletion = result.writeAttempts.find((a) => a.tool === "deleteFile");
    assert.ok(deletion, "the deletion attempt is recorded even though the gate was never consulted");
    assert.strictEqual(deletion.layer, "the tool set");
    assert.ok(
      fs.existsSync(path.join(fx.seriesDir, `${SERIES}(15)`, "glossary.md.rejected")),
      "the evidence is still there — a refused attempt must not have happened"
    );

    // The proposal reached the patch through the only door, and the refusals travelled with it.
    assert.ok(result.patch.summary.includes("every alias inside its term cell"));
    assert.deepStrictEqual(result.patch.files, ["glossary.js"]);
    assert.strictEqual(result.patch.expected[0].signal, "glossaryTerms");
    assert.strictEqual(result.patch.expected[0].direction, "up");
    assert.strictEqual(result.patch.refusedWrites.length, 2);
    assert.deepStrictEqual(result.patch.testChain.before, "node checks/green.js");
    assert.deepStrictEqual(result.patch.testChain.after, "node checks/green.js");

    // The wire really advertised the five file tools plus the two memory tools the harness adds for this
    // role, and nothing else. The memory tools are the harness's, not this module's: the write gate still
    // judges exactly the five file tools the banned-path table is written against.
    const advertisedNames = backend.requests.map((r) =>
      (r.tools || []).map((t) => t.name ?? t.function?.name).filter(Boolean).sort().join(",")
    );
    assert.ok(advertisedNames.length >= 3, "reads, the edit, the refused writes, then the answer");
    for (const names of advertisedNames) {
      assert.strictEqual(names, "editFile,grep,listFiles,manage_context,readFile,recall_memory,writeFile", names);
    }

    // And the manager's report says what the team tried.
    const report = fs.readFileSync(fx.patchPaths.markdown, "utf8");
    assert.ok(report.includes(result.patch.id));
    assert.ok(report.includes("utils/tickets.js"), "a refused write is visible to the reader who decides");
    assert.ok(report.includes("the tool set"));
  } finally {
    await backend.close();
  }
}

// ─── 7. A turn needs a tree it can describe ───────────────────────────────────

/**
 * The refusal lives inside `workTicket`, after the tree is read and BEFORE the patch is opened: a patch
 * left sitting at `proposed` with no proposal gates act mode and describes nothing.
 */
async function scenarioATurnMayNotStartFromSomebodyElsesEdits() {
  const { fx, ticket } = openChannel("dirty");
  fs.writeFileSync(path.join(fx.root, "glossary.js"), "module.exports = { editedBy: \"nobody\" };\n", "utf8");
  fs.mkdirSync(path.join(fx.root, "notes"), { recursive: true });
  fs.writeFileSync(path.join(fx.root, "notes/loose.md"), "an untracked file\n", "utf8");

  const result = await devteam.workTicket({
    ticketId: ticket.id,
    seriesDir: fx.seriesDir,
    root: fx.root,
    patchPaths: fx.patchPaths,
    ticketsFile: fx.ticketPaths.json,
  });

  assert.strictEqual(result.ok, false);
  assert.ok(result.error.includes("already holds 2 change(s) no patch declares"), result.error);
  assert.ok(result.error.includes("glossary.js") && result.error.includes("notes/loose.md"), result.error);
  assert.strictEqual(result.patch, null, "no patch was opened, so nothing is left gating act mode");
  assert.deepStrictEqual(patches.readPatches(fx.patchPaths.json).patches, []);
  assert.strictEqual(patches.pendingPatches(fx.patchPaths).length, 0);
  assert.strictEqual(patches.unresolvedPatches(fx.patchPaths).length, 0);

  // An unknown ticket is refused the same way — before any git call and before any model call.
  const missing = await devteam.workTicket({
    ticketId: "TCK-nope-9",
    seriesDir: fx.seriesDir,
    root: fx.root,
    patchPaths: fx.patchPaths,
    ticketsFile: fx.ticketPaths.json,
  });
  assert.strictEqual(missing.ok, false);
  assert.ok(missing.error.includes("no ticket TCK-nope-9"));
  assert.ok(missing.error.includes("diagnose.js --open"), "the refusal names where to look instead");
}

/** A write the proposal does not name is a refusal, not a surprise the manager discovers later. */
async function scenarioAnUndeclaredWriteIsRefused() {
  const { fx, ticket } = openChannel("undeclared");
  const backend = await startFakeBackend({
    model: "stub",
    reply: devTeamReply({ extraWrites: ["utils/prompt.js"] }),
  });
  backend.pointEnvAt();

  try {
    const result = await devteam.workTicket({
      ticketId: ticket.id,
      seriesDir: fx.seriesDir,
      root: fx.root,
      patchPaths: fx.patchPaths,
      ticketsFile: fx.ticketPaths.json,
    });

    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(
      result.actualChanges.sort(),
      ["glossary.js", "utils/prompt.js"],
      "the fingerprint reports both edits, whether or not the team admits them"
    );
    const problem = result.problems.find((p) => p.kind === "undeclared-change");
    assert.ok(problem, result.problems.map((p) => p.kind).join(", "));
    assert.deepStrictEqual(problem.files, ["utils/prompt.js"]);

    // Refused: the proposal is not attached, but the attempt and the tree are recorded.
    const stored = patches.findPatch(result.patch.id, patches.readPatches(fx.patchPaths.json).patches);
    assert.strictEqual(stored.summary, undefined, "no proposal is attached to a proposal that lied about its files");
    assert.strictEqual(stored.status, "proposed");
    assert.strictEqual(stored.refusedAttempts.length, 1);
    assert.ok(stored.refusedAttempts[0].problems.some((p) => p.kind === "undeclared-change"));
    assert.ok(stored.refusedWrites.length >= 2, "the banned write and the deletion survive the refusal");

    const report = fs.readFileSync(fx.patchPaths.markdown, "utf8");
    assert.ok(report.includes("Attempts the machine refused before this one"), report);
  } finally {
    await backend.close();
  }
}

/** A turn that dies part-way is an unfinished patch, not a clean refusal — because the tree is already edited. */
async function scenarioATurnThatDiesPartWayIsReportedAsUnfinished() {
  const { fx, ticket } = openChannel("turn-failed");
  const backend = await startFakeBackend({ model: "stub", reply: devTeamReply({ proposal: null }) });
  backend.pointEnvAt();

  try {
    const result = await devteam.workTicket({
      ticketId: ticket.id,
      seriesDir: fx.seriesDir,
      root: fx.root,
      patchPaths: fx.patchPaths,
      ticketsFile: fx.ticketPaths.json,
    });

    assert.strictEqual(result.ok, false);
    assert.ok(result.patch, "the patch is still there, because the tree still holds the edit");
    assert.ok(result.error.includes("produced no proposal"), result.error);
    assert.ok(result.error.includes("1 file(s)"), result.error);
    assert.ok(result.error.includes(fx.root), "it names the tree it is talking about, not a hardcoded folder");
    assert.ok(result.error.includes(`--revert=${result.patch.id}`), "and the way back");
    assert.strictEqual(patches.unresolvedPatches(fx.patchPaths).length, 1, "act mode will refuse to run a step");
  } finally {
    await backend.close();
  }
}

// ─── 8. The checks are run by the machine ─────────────────────────────────────

/**
 * The team has no shell, so "run the tests" is a requirement the CLI meets. The status follows what the
 * pinned commands actually returned — twice, because a patch is re-graded when the tree changes.
 */
async function scenarioTheMachineRunsThePinnedChecks() {
  const { fx, ticket } = openChannel("checks");
  const backend = await startFakeBackend({ model: "stub", reply: devTeamReply() });
  backend.pointEnvAt();

  let patchId;
  try {
    const turn = await devteam.workTicket({
      ticketId: ticket.id,
      seriesDir: fx.seriesDir,
      root: fx.root,
      patchPaths: fx.patchPaths,
      ticketsFile: fx.ticketPaths.json,
    });
    assert.ok(turn.ok, turn.error);
    patchId = turn.patch.id;
  } finally {
    await backend.close();
  }

  // Green: the fixture's own package.json is what `npm test` and `npm run pipeline-loop` resolve.
  const green = devteam.verifyPatch(patchId, { root: fx.root, patchPaths: fx.patchPaths });
  assert.ok(!green.error, green.error);
  assert.strictEqual(green.verdict.accepted, true, JSON.stringify(green.verdict));
  assert.deepStrictEqual(green.verdict.missing, []);
  assert.strictEqual(green.patch.status, "verified");
  const recorded = patches.findPatch(patchId, patches.readPatches(fx.patchPaths.json).patches);
  assert.deepStrictEqual(recorded.checks.map((c) => c.id), ["npm-test", "pipeline-loop"]);
  for (const c of recorded.checks) {
    assert.strictEqual(c.exitCode, 0);
    assert.strictEqual(c.passed, true);
    // The command recorded is the PINNED one, not whatever a caller wished for.
    assert.ok(/^npm test$/.test(c.command) || /^npm run pipeline-loop$/.test(c.command), c.command);
  }

  // Red: the same patch, the same commands, a tree that now fails them.
  process.env.FIXTURE_CHECK_EXIT = "1";
  try {
    const red = devteam.verifyPatch(patchId, { root: fx.root, patchPaths: fx.patchPaths });
    assert.strictEqual(red.verdict.accepted, false);
    assert.strictEqual(red.patch.status, "proposed", "a patch does not stay verified because it once was");
    assert.ok(red.verdict.failed.some((f) => /exited 1/.test(f)), red.verdict.failed.join("; "));
  } finally {
    delete process.env.FIXTURE_CHECK_EXIT;
  }

  // A check that never ran is reported as missing, not as passed.
  const never = patches.recordChecks(
    patchId,
    [{ id: "npm-test", command: "npm test", exitCode: 0, passed: true, tail: "", at: new Date().toISOString() }],
    fx.patchPaths
  );
  assert.strictEqual(never.verdict.accepted, false);
  assert.deepStrictEqual(never.verdict.missing, ["pipeline-loop"]);
  assert.deepStrictEqual(never.verdict.failed, [], "a check that never ran is reported as missing, not as a failure — the two are different facts and the report prints them on separate lines");

  const report = fs.readFileSync(fx.patchPaths.markdown, "utf8");
  assert.ok(report.includes("never ran:"), "the report names the check that never ran");
}

// ─── 9. The CLI ───────────────────────────────────────────────────────────────

function runFix(args, env = {}) {
  return spawnSync(process.execPath, ["fix.js", ...args], {
    cwd: __dirname.replace(/test$/, ""),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

/**
 * Every refusal here happens before a model call and before a check runs. None of them passes a real
 * patch id or a real ticket id, because `--verify` and `--ticket` default to the REAL project root and
 * there is no `--root` flag — a real id here would run the real test chain or edit the real repo.
 */
async function scenarioTheCliRefusesBeforeItReachesAModel() {
  const { fx, ticket } = openChannel("cli");
  const channel = { POSTMORTEM_DIR: fx.channel };

  const unknownFlag = runFix(["--frobnicate"], channel);
  assert.strictEqual(unknownFlag.status, 2, unknownFlag.stderr);
  assert.ok(/unknown flag/.test(unknownFlag.stderr), unknownFlag.stderr);

  const nothing = runFix([], channel);
  assert.strictEqual(nothing.status, 2);
  assert.ok(/nothing to do/.test(nothing.stderr), nothing.stderr);

  const open = runFix(["--open"], channel);
  assert.strictEqual(open.status, 0, open.stderr);
  assert.ok(open.stdout.includes(ticket.id), open.stdout);
  assert.ok(open.stdout.includes("fix.js --ticket="), "it names the command that answers it");

  const status = runFix(["--status"], channel);
  assert.strictEqual(status.status, 0, status.stderr);
  assert.ok(/no patches|PATCH-/i.test(status.stdout), status.stdout);

  const showUnknown = runFix(["--show=PATCH-999"], channel);
  assert.strictEqual(showUnknown.status, 2, showUnknown.stdout);
  assert.ok(/no patch PATCH-999/.test(showUnknown.stderr), showUnknown.stderr);

  const verifyUnknown = runFix(["--verify=PATCH-999"], channel);
  assert.strictEqual(verifyUnknown.status, 2, verifyUnknown.stdout);
  assert.ok(/no patch PATCH-999/.test(verifyUnknown.stderr), verifyUnknown.stderr);
  assert.ok(
    !verifyUnknown.stdout.includes("Running the pinned checks"),
    "an unknown id must not spend the test chain: " + verifyUnknown.stdout
  );

  const revertUnknown = runFix(["--revert=PATCH-999"], channel);
  assert.strictEqual(revertUnknown.status, 2, revertUnknown.stdout);
  assert.ok(/no patch PATCH-999/.test(revertUnknown.stderr), revertUnknown.stderr);

  const twoActions = runFix(["--status", "--show=PATCH-999"], channel);
  assert.strictEqual(twoActions.status, 2, twoActions.stdout);
  assert.ok(/one thing at a time|one action/.test(twoActions.stderr + twoActions.stdout), twoActions.stderr);

  const unknownTicket = runFix(["--ticket=TCK-nope-9", `--series=${fx.seriesDir}`], channel);
  assert.strictEqual(unknownTicket.status, 2, unknownTicket.stdout);
  assert.ok(/no ticket TCK-nope-9/.test(unknownTicket.stderr), unknownTicket.stderr);
  assert.ok(unknownTicket.stderr.includes("diagnose.js --open"), unknownTicket.stderr);

  const noSeries = runFix(["--ticket=TCK-nope-9"], { ...channel, SERIES_LOCATION: "" });
  assert.strictEqual(noSeries.status, 2, noSeries.stdout);
  assert.ok(/no series folder/.test(noSeries.stderr), noSeries.stderr);

  const badSeries = runFix(["--ticket=TCK-nope-9", `--series=${path.join(fx.root, "no-such-folder")}`], channel);
  assert.strictEqual(badSeries.status, 2, badSeries.stdout);
  assert.ok(/does not exist/.test(badSeries.stderr), badSeries.stderr);
}

/**
 * The run lock is binding for anything that mutates the tree and merely allowed for a read. Both cases
 * exit 2 for an unknown id, so the assertion is on the SENTENCE: a refusal that does not name the run
 * looks like caution, and caution is what gets switched off (gotcha 71).
 */
async function scenarioTheRunLockIsBindingForAMutatingFlag() {
  const { fx } = openChannel("lock");
  const lockPath = path.join(fx.channel, "run.lock");
  fs.writeFileSync(
    lockPath,
    JSON.stringify(
      { runId: "someone-elses-run", pid: process.pid, host: os.hostname(), by: "pipeline", startedAt: new Date().toISOString() },
      null,
      2
    ) + "\n",
    "utf8"
  );
  const channel = { POSTMORTEM_DIR: fx.channel };

  const mutating = runFix(["--ticket=TCK-nope-9", `--series=${fx.seriesDir}`], channel);
  assert.strictEqual(mutating.status, 2, mutating.stdout);
  assert.ok(/refused:/.test(mutating.stderr), mutating.stderr);
  assert.ok(mutating.stderr.includes("someone-elses-run"), mutating.stderr);
  assert.ok(!mutating.stderr.includes("no run lock"), mutating.stderr);
  assert.ok(/may not land while a run is in progress/.test(mutating.stderr), mutating.stderr);

  const verifyFlag = runFix(["--verify=PATCH-999"], channel);
  assert.strictEqual(verifyFlag.status, 2);
  assert.ok(verifyFlag.stderr.includes("someone-elses-run"), verifyFlag.stderr);

  // Reading the channel while a run is going is harmless, and stays allowed.
  const reading = runFix(["--status"], channel);
  assert.strictEqual(reading.status, 0, reading.stderr);
  assert.ok(!reading.stdout.includes("someone-elses-run"), reading.stdout);
  const listing = runFix(["--open"], channel);
  assert.strictEqual(listing.status, 0, listing.stderr);

  // And with the lock gone the same command reaches the real question instead of the lock.
  fs.rmSync(lockPath, { force: true });
  const after = runFix(["--ticket=TCK-nope-9", `--series=${fx.seriesDir}`], channel);
  assert.strictEqual(after.status, 2, after.stdout);
  assert.ok(/no ticket TCK-nope-9/.test(after.stderr), after.stderr);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ["the write boundary refuses by rule, and the tool set refuses deletion", scenarioTheWriteBoundaryRefusesByRule],
  ["both layers of the boundary are recorded, and a real edit is not a refusal", scenarioBothLayersAreRecorded],
  ["the proposal is parsed fail-closed, and the last block is the answer", scenarioTheProposalIsParsedFailClosed],
  ["the turn has no step cap, and the record says how it ran", scenarioTheDevTurnHasNoStepCap],
  ["the tool note says what the role actually has", scenarioTheToolNoteSaysWhatTheRoleHas],
  ["the brief carries the ticket and names the tree it will edit", scenarioTheBriefCarriesTheTicketAndNamesTheTree],
  ["a whole dev turn: the edit lands, the banned write is recorded, the proposal is attached", scenarioAWholeDevTurnRunsForReal],
  ["a dev turn may not start from a tree somebody else already edited", scenarioATurnMayNotStartFromSomebodyElsesEdits],
  ["a write the proposal does not name is refused, not discovered later", scenarioAnUndeclaredWriteIsRefused],
  ["a turn that dies part-way is an unfinished patch, not a clean refusal", scenarioATurnThatDiesPartWayIsReportedAsUnfinished],
  ["the machine runs the pinned checks and the status follows what returned", scenarioTheMachineRunsThePinnedChecks],
  ["the CLI refuses before it reaches a model or a check", scenarioTheCliRefusesBeforeItReachesAModel],
  ["the run lock is binding for a mutating flag and not for a read", scenarioTheRunLockIsBindingForAMutatingFlag],
];

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  // The `verifyPatch` scenario runs the pinned `npm test` inside a fixture folder on purpose. A
  // package.json with no scripts at the top of TMP is the backstop that stops npm walking up and
  // running THIS suite inside itself if a fixture ever loses its own.
  fs.writeFileSync(
    path.join(TMP, "package.json"),
    JSON.stringify({ name: "oresuki-devteam-test-fixture", version: "1.0.0", private: true }, null, 2) + "\n",
    "utf8"
  );

  for (const [label, fn] of scenarios) {
    try {
      await fn();
      console.log(`  ok   ${label}`);
    } catch (err) {
      console.error(`  FAIL ${label}\n${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    }
  }

  if (process.exitCode) {
    console.error(`\nFAILED: the dev team's boundary does not hold.`);
    return;
  }
  console.log(
    `\nOK: ${scenarios.length} checks on the dev team — the write boundary, the proposal, the turn, ` +
      `the tree it may edit, the pinned checks, the CLI.`
  );
}

main();
