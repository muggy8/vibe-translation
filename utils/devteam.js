/**
 * utils/devteam.js — the dev team: the role that may change the code, and the reason it is the last
 * role in this pipeline rather than the first.
 *
 * The delivery manager (delivery.js, utils/resume.js) runs the pipeline and may re-run steps, but it
 * never sees the code. The diagnostics team (utils/diagnostics.js) may read everything and change
 * nothing. This is the third role: the one that writes. It exists only because the manager chose an
 * option the diagnostics team offered and that option said `requiresCodeChange` — so a code change is
 * never requested by describing a fix, only by choosing an offered option (plan §9).
 *
 * The analogy the account owner chose (2026-10-05): the manager is a SaaS **client** with a support
 * contract; diagnostics and this team are the **provider**. A provider fixes its own software, tells
 * the client what it changed and what it might break, and asks clarifying questions back — and the
 * client's whole authority is to accept or refuse.
 *
 * Four rules make that survivable, and all four are enforced in code:
 *
 *   1. **A patch may not edit the rules that judge it.** `BANNED_PATCH_PATHS` (utils/patches.js) is
 *      enforced twice: the file tools refuse the write during the turn, and `recordProposal` refuses
 *      the proposal afterwards. The cheapest way to make a finding disappear is now a line of code
 *      rather than a setting, so the constraint-table modules, their tests, `hooks/`, `.env`, the
 *      machine state and the corpus are off the menu — each refusal naming the account owner.
 *   2. **A patch shows its changes.** The working tree inside `ai-client/` is fingerprinted before the
 *      turn and again after it. A file that changed without being named in the proposal is a
 *      **refusal**, not a note: an unreviewed edit is the thing the manager cannot judge. A file named
 *      that did not change is a warning (gotcha 74's two-directional honesty).
 *   3. **The tests are run by the CLI, not claimed by the team.** The harness gives an agent no shell
 *      tool, so a prompt that said "run the tests" would be a prompt asking for the impossible — and
 *      a proposal that said "I ran them" would be unverifiable. `REQUIRED_CHECKS` is executed by
 *      `fix.js` through `patches.runChecks`, and a proposal cannot be accepted while one is missing
 *      or failed.
 *   4. **The team proposes; it does not deliver.** The turn ends as a proposal the manager reads
 *      without a diff. The commit to `main` is the acceptance act, it happens only after the manager
 *      accepts, and it stages exactly the files the proposal declared (`git add -A` is never used in
 *      this repository: the tree outside `ai-client/` is the account owner's in-progress translation).
 *
 * Where the work happens: the working tree of `main`, uncommitted, while the manager judges it. That
 * is the dangerous part of this design and it is worth saying out loud — the working tree IS what
 * `npm run pipeline` executes (gotcha 66), which is why `pendingPatches()` gates act mode, why only
 * one team works at a time, and why a patch may not land while a run is in progress.
 *
 * Cost (plan §9): one model call per patch, and the turn is UNCAPPED — it keeps its own working window
 * by setting its old read answers aside on disk (see the note below `DELETION_REFUSAL`, and
 * `utils/context.js`). What bounds it is the repetition detector and the turn clock, not a step count:
 * this role reads code before it writes it, and a step count is exactly what threw away a paid-for
 * dev turn mid-edit (gotcha 64/65).
 */
"use strict";

const fs = require("fs");
const path = require("path");

const harness = require("../harness");
const { assertRealToolCalls, turnShapeOf } = require("./agents");
const { extractJsonObject } = require("./manifest");
const patches = require("./patches");
const tickets = require("./tickets");
// The role fires its own hooks around its own model turn: `fix.js` cannot know whether this module is
// about to reach the model without repeating every refusal `workTicket` makes, and on a machine where
// a switch means loading a container the guarantee has to belong to the caller (gotcha 22).
const { runTurnWithHooks, MANAGER_TASK } = require("./hooks");

const ROOT = path.join(__dirname, "..");
const SYSTEM_PROMPT_FILE = path.join(ROOT, "system-prompts", "devteam.md");

/**
 * The tools a mutating agent could reach for. `deleteFile` is never offered by the harness at all
 * (gotcha 8); it is listed so the gate names it if a future library version injects it.
 */
const MUTATING_TOOL_NAMES = ["writeFile", "editFile", "deleteFile"];

/** The sentence the ticket records when the gate stops a write. */
const DELETION_REFUSAL =
  "a patch may not delete a file. Removing evidence, a report or an artifact is a Tier C move the " +
  "delivery manager may not make either (utils/resume.js), so it is not something the dev team can do " +
  "on the account owner's behalf. Say in ownerNote what should be removed, and let the account owner " +
  "remove it.";

/*
 * This role has NO step cap, on purpose (plan §7). It used to carry
 * `min(160, max(40, pages * 3 + 32))` — 3 steps per 32 KB of evidence the ticket pointed at, ceiling
 * 160 — and the ceiling was justified in a comment as "a turn that needs more reading than this is
 * being pointed at the wrong problem". That is exactly the sentence a cap writes about itself, and the
 * live run disproved it: the diagnosis this role's own ticket came out of ran 39 steps, made 73 tool
 * calls, spent 7.2M tokens, re-opened the same file 12 times, and answered with ZERO characters of
 * text — because the cap stopped it mid-reading, not because the problem was too big for a turn.
 * gotcha 64 and gotcha 65 are the same story twice more: 25 step-cap warnings in one run, and a
 * 46-tool-call feedback pass that ran out of steps before it had written anything.
 *
 * What bounds the turn now instead of a step count:
 *   - the repetition detector (AGENT_REPEAT_LIMIT) — the same call, the same arguments, the same
 *     answer, three times, is the shape of a spin, and it stops the turn where a step count would
 *     only have stopped it later and less honestly;
 *   - the turn clock (AGENT_TURN_MAX_MS) — a loose wall, not a budget;
 *   - the working window (utils/context.js) — old read answers are SET ASIDE on disk rather than
 *     dropped, so "I have read too much" is no longer a reason to run out of room, and the agent can
 *     call `recall_memory` to bring one back.
 * There is still deliberately no token budget anywhere in this layer (plan §9): what stops a spin is
 * the ledger (gotcha 69), not a spending limit.
 */

/**
 * The tool note appended to the system prompt in code (the convention: prompt files stay
 * mode-agnostic, mode-specific text is appended here — see AGENTS.md §11).
 *
 * Three things it must say that `AGENT_TOOLS_NOTE` cannot: which files this role may NOT write, the
 * fact that it has no shell, and how its working window works now that this turn has no step limit.
 * The harness gives an agent no way to run a command, so a brief that
 * asked the team to "run the tests" would spend the turn discovering that it cannot, and a
 * proposal that claimed it had run them would be unverifiable (gotcha 8's `deleteFile` transcripts are
 * exactly this shape: turns reasoning about a tool that does not exist).
 */
const DEVTEAM_TOOLS_NOTE = `

## Your tools (you may write, inside a boundary)

You have five file tools and two memory tools: \`readFile(filePath)\`, \`listFiles(dirPath)\`,
\`grep(pattern, dirPath, glob?, ignoreCase?)\`, \`writeFile(filePath, content)\`,
\`editFile(filePath, oldString, newString)\`, \`manage_context(note?)\` and \`recall_memory(query, limit?)\`.

- \`editFile\`'s parameter is \`oldString\` / \`newString\`. There is no \`oldText\`.
- \`grep\` and \`listFiles\` take a FOLDER, not a file. To search one file, pass its folder and use
  \`glob\` as a filename ENDING (\`".md"\`, not \`"*.md"\` — a wildcard matches nothing).
- There is no \`deleteFile\`. Removing a file is not something this role may do.
- You have NO shell and no way to run a command. You cannot run \`npm test\`, and you must not claim you
  did. The machine runs the checks after your turn and records what they actually returned.

You may read anywhere in the project. You may WRITE only inside this project's own source, and these
are refused even if you try:

- \`utils/tickets.js\`, \`utils/resume.js\`, \`utils/delivery-verify.js\`, \`utils/ledger.js\`,
  \`utils/runlock.js\`, \`utils/patches.js\` — the rules that constrain you and the manager.
- \`test/test-tickets.js\`, \`test/test-resume.js\`, \`test/test-delivery-verify.js\`,
  \`test/test-ledger.js\`, \`test/test-delivery-act.js\`, \`test/test-diagnostics.js\`,
  \`test/test-patches.js\` — the tests that prove those rules work.
- \`hooks/\` (per-machine scripts), \`.env\` and \`.env.example\` (the settings), \`.postmortem/\`,
  \`.logs/\`, \`.dry-run/\`, \`node_modules/\`.
- Anything that is generated pipeline output: a volume folder's artifacts, \`test-series/\`, any
  \`.rejected\` file, any \`*-rolling-state.json\`, any \`.provenance.json\`.
- Anything outside this project.

A refused write is recorded on the patch and the manager reads it. If you believe one of those files
is the right answer, do not try to edit it — write it in \`ownerNote\` instead, in prose, with the
evidence, and name what you would change. That is the only route to a change in those files.

## Your working window (read this before you read anything)

You have no step limit: this turn ends when you propose, when you start repeating yourself, or when the
clock runs out. What DOES run out is how much text you can hold in mind at once, and every tool answer
ends with a line saying how full that is:

\`| working window: 57,500 / 262,144 tokens (22%)\`

- **getting full** — call \`manage_context()\` BEFORE your next read. It sets aside the oldest read
  answers and leaves a note of where they went, so the turn can keep going.
- **FULL** — call it immediately. The next read is at risk of being cut off.
- Setting a read aside is not forgetting it. \`recall_memory("a phrase from it")\` searches everything
  this turn has set aside and brings back the matching part, named with the file it came from. Recall
  it instead of opening the whole file again.
- **Your own edits are never set aside.** Only the answers you READ are moved to disk. Every change you
  made stays in front of you, so you always know what you have already written.

## How to finish

Work in one pass: grep to locate, read what you located, change it, then answer. Do not re-read a file
you have already read — if you cannot recall what it said, search what you set aside. Then write the
proposal as ONE fenced \`\`\`json block, exactly this shape:

\`\`\`json
{
  "files": ["glossary.js", "utils/prompt.js"],
  "summary": "what changed, in language the manager can repeat",
  "why": "the mechanism the patch fixes, not the finding it removes",
  "couldBreak": "what this change could damage",
  "expected": [{ "signal": "glossaryTerms", "direction": "up", "why": "why that number moves" }],
  "verify": "how the manager checks it worked, using something a reader with no code access can look at",
  "questions": ["what you need from the manager before this is committed"],
  "ownerNote": "for the account owner alone, or an empty string"
}
\`\`\`

\`signal\` must be one of the names the acceptance test measures: ${patches.SIGNAL_NAMES.join(
  ", "
)}. Naming a number nobody measures is refused: your claim has to be checkable by the
before/after comparison that already exists, not by a scoreboard you invented.`;

/**
 * Build the dev team's tool set and its gate.
 *
 * Two layers again (gotcha 8's pattern, which gotcha 74 applies to writes): the harness's own gate
 * confines writes to the project, and this gate refuses the banned paths inside it and RECORDS each
 * refusal. The recording is the point — a silently dropped write attempt is a dev team that quietly
 * edited the constraint table and nobody ever found out.
 *
 * The check runs on the path the agent actually passed, before the harness repairs it (gotcha 60): a
 * repaired path must never slip past a gate that judged the original one.
 *
 * @param {Object} cfg
 * @param {string} cfg.cwd
 * @param {string[]} cfg.allowedDirs
 * @returns {Promise<{tools: Object, approve: Function, refusals: Object[], advertised: string[]}>}
 */
async function patchFsTools({ cwd = ROOT, allowedDirs = [ROOT] }) {
  const { tools, approve: fsApprove } = await harness.createGatedFsTools({ cwd, allowedDirs });

  /** @type {Array<{tool: string, path: string, rule: string|null, reason: string, at: string}>} */
  const refusals = [];

  const approve = (call) => {
    const toolName = call && call.toolName;
    if (MUTATING_TOOL_NAMES.includes(toolName)) {
      const input = (call && call.input) || {};
      const target = input.filePath || input.dirPath || input.path || "(no path given)";
      if (toolName === "deleteFile") {
        refusals.push({ tool: toolName, path: target, rule: "delete-file", reason: DELETION_REFUSAL, at: new Date().toISOString() });
        harness.logLine(`  [devteam] REFUSED deleteFile on ${target}: ${DELETION_REFUSAL}`);
        return false;
      }
      const verdict = patches.patchPathIsBanned(target, cwd);
      if (verdict.banned && verdict.rule) {
        const reason = `${verdict.rule.because} It goes to ${verdict.rule.escalateTo}`;
        refusals.push({ tool: toolName, path: target, rule: verdict.rule.id, reason, at: new Date().toISOString() });
        harness.logLine(`  [devteam] REFUSED ${toolName} on ${target} (${verdict.rule.id}): ${reason}`);
        return false;
      }
    }
    // Reads, and writes the banned list is silent about, go through the harness gate unchanged.
    return fsApprove(call);
  };

  return { tools, approve, refusals, advertised: Object.keys(tools || {}) };
}

/**
 * Both layers of the write boundary, recorded together.
 *
 * For this role the tool-set layer only fires for `deleteFile` (the harness does not advertise it, so
 * the provider answers before the call reaches the sandbox). The gate layer fires for the banned
 * paths. Counting only the gate's log would report "the team never tried" for the common case where it
 * tried and the tool set said no — the exact mistake gotcha 74 describes.
 *
 * The third argument keeps the record honest in the other direction. Unlike the read-only team, this role
 * IS offered `writeFile` and `editFile`, and a normal turn uses them. Reading every mutating tool call as
 * a refusal would report the edit the patch exists for as "the tool set refused the call before it reached
 * the sandbox" — true of `deleteFile`, a lie about the work. So a call counts as a tool-set refusal only
 * when its name is NOT in `advertised`, which is exactly the condition under which the provider answers
 * before the sandbox is reached. A write that succeeded is reported where it belongs: in `actualChanges`,
 * the tree fingerprint.
 *
 * @param {Array<{tool: string, path: string, rule: string|null, reason: string, at: string}>} refusals
 * @param {Array<{name: string, input: Object}>} toolCalls
 * @param {string[]} [advertised] the tool names the role was actually handed (empty = assume none of the
 *   mutating ones were, which is the read-only role's case)
 * @returns {Array<{tool: string, path: string, rule: string|null, reason: string, layer: string, at: string}>}
 */
function collectPatchWriteAttempts(refusals, toolCalls, advertised = []) {
  const out = (refusals || []).map((r) => ({ ...r, layer: "the approve gate" }));
  const seen = new Set(out.map((r) => `${r.tool}\u0000${r.path}`));
  for (const call of toolCalls || []) {
    if (!MUTATING_TOOL_NAMES.includes(call.name)) continue;
    // The gate approved this one, so the only open question is whether the tool set ever offered it.
    if (advertised.includes(call.name)) continue;
    const target = (call.input && (call.input.filePath || call.input.dirPath)) || "(no path given)";
    const key = `${call.name}\u0000${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool: call.name,
      path: target,
      rule: call.name === "deleteFile" ? "delete-file" : null,
      reason:
        `${call.name} is not offered to this role at all — the tool set refused the call before it ` +
        `reached the sandbox. ${call.name === "deleteFile" ? DELETION_REFUSAL : "the write boundary applies regardless."}`,
      at: new Date().toISOString(),
      layer: "the tool set",
    });
  }
  return out;
}

/**
 * Parse the dev turn's reply. Fail-closed on the shape, like `parseDiagnosisReply` and
 * `parseAcceptanceReply`: a proposal another program cannot read is not a thin proposal.
 *
 * @param {string} text
 * @returns {{proposal: Object|null, problems: Object[]}}
 */
function parseProposalReply(text) {
  if (typeof text !== "string" || !text.trim()) {
    return {
      proposal: null,
      problems: [
        {
          kind: "empty-reply",
          message:
            "the dev turn produced no proposal. The turn's tool calls and any files it wrote are still " +
            "in the working tree and in .logs/ — read them before re-running, because a turn stopped for " +
            "repeating itself or for running past the turn clock is a different problem from a turn that " +
            "answered nothing, and this turn has no step limit to blame.",
        },
      ],
    };
  }

  // The LAST fenced JSON block: a real answer reasons in prose first and puts the machine-readable
  // part at the end. `extractJsonObject` takes first-{ to last-}, which mangles a reply that quotes an
  // example inside its prose.
  let raw = null;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map((m) => m[1])
    .filter((block) => block.trim().startsWith("{"));
  for (let i = fences.length - 1; i >= 0 && raw === null; i -= 1) {
    try {
      raw = JSON.parse(fences[i].trim());
    } catch {
      /* try the previous block */
    }
  }
  if (raw === null) {
    try {
      raw = extractJsonObject(text);
    } catch (err) {
      return {
        proposal: null,
        problems: [
          {
            kind: "unparseable",
            message:
              `the reply does not contain the JSON object the brief asks for (${err.message}). Write ` +
              `the proposal as one fenced \`\`\`json block with files / summary / why / couldBreak / ` +
              `expected / verify. Prose alone is not a proposal the manager can judge.`,
          },
        ],
      };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { proposal: null, problems: [{ kind: "not-an-object", message: "the reply parsed as something other than one JSON object." }] };
  }
  return { proposal: raw, problems: [] };
}

/**
 * The ticket, the chosen option and the diagnosis it came from, as the dev team's brief.
 *
 * It is handed the code access the manager does not have, so this text is about the DECISION: what
 * was found, what was already tried, which option was chosen and what that option promised. The team
 * is not told what to write — it is told what was agreed.
 *
 * `root` is the folder the turn is actually about to edit, and the brief names it. A brief that named
 * this module's own folder while the turn ran somewhere else would send the team to write in a tree the
 * machine is not fingerprinting.
 *
 * @param {Object} ticket
 * @param {Object} patch
 * @param {Object} option
 * @param {string} seriesDir
 * @param {string} [root]
 * @returns {string}
 */
function renderTicketForDev({ ticket, patch, option, seriesDir, root = ROOT }) {
  const d = ticket.diagnosis || {};
  const lines = [
    `## Ticket ${ticket.id} — ${ticket.step}${ticket.volume ? ` volume ${ticket.volume}` : ""}`,
    ``,
    `Finding: \`${ticket.finding}\``,
    ``,
    `### What the diagnostics team found`,
    d.cause || "*(no cause recorded)*",
    ``,
    `### The option the manager chose (${option.id})`,
    `**${option.label}**`,
    `- it touches: ${(option.touches || []).join(", ") || "not stated"}`,
    `- its cost: ${option.cost || "not stated"}`,
    `- its risk: ${option.risk || "not stated"}`,
    `- how the manager will check it: ${option.verify || "not stated"}`,
    ``,
    `**Why the manager chose it:** ${patch.chosenReason || ticket.choice.reason}`,
    ``,
    `### What the run already tried`,
    ...((ticket.tried || []).length
      ? ticket.tried.map((t) => `- ${t.action}${t.volume ? ` (volume ${t.volume})` : ""} → ${t.outcome} [${t.ledgerEntry || "no ledger id"}]`)
      : ["- *(nothing recorded)*"]),
    ``,
    `### What was ruled out`,
    ...((ticket.ruledOut || []).length ? ticket.ruledOut.map((r) => `- ${r}`) : ["- *(nothing recorded)*"]),
    ``,
    `### The question the manager asked`,
    ticket.question,
    ``,
    `### The evidence, at the paths the triage named them`,
    ...((ticket.evidence || []).length
      ? ticket.evidence.map((e) => `- \`${e.file}\` — ${e.note}`)
      : ["- *(none recorded)*"]),
    ``,
    `The series folder is \`${seriesDir}\`. The project root (where the code you may change lives) is`,
    `\`${root}\`. A volume folder's own artifacts are generated output: read them, do not edit them.`,
    ``,
    `Change the mechanism. Then report what you changed, why, what it could break, and what the`,
    `manager should look at afterwards to know it worked.`,
  ];
  return lines.join("\n");
}

/**
 * Total size of the files a ticket points at. The same rule and the same shape as `evidenceFootprint`
 * in utils/diagnostics.js, so the two roles size the same ticket the same way — but the number is no
 * longer a step cap: it is printed so a reader can see how much the turn was pointed at, and it is the
 * thing the working window has to absorb (gotcha 64: a turn that cannot hold what it was pointed at
 * throws away paid-for work; the fix is to set the old read answers aside, not to count steps).
 *
 * @param {Object} ticket
 * @param {string[]} [extraFiles]
 * @param {string} [seriesDir]
 * @param {string} [root]
 * @returns {Promise<{bytes: number, files: string[]}>}
 */
async function evidenceFootprint(ticket, extraFiles = [], seriesDir = "", root = ROOT) {
  const candidates = [...(ticket.evidence || []).map((e) => e.file), ...extraFiles];
  const bases = [root, seriesDir, ticket.seriesDir || ""].filter(Boolean);
  let bytes = 0;
  const files = [];
  for (const raw of candidates) {
    for (const base of bases) {
      const abs = path.isAbsolute(raw) ? raw : path.join(base, raw);
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.isFile()) {
          bytes += stat.size;
          files.push(abs);
          break;
        }
      } catch {
        /* a missing file is not a size, and inventing one would inflate the cap */
      }
    }
  }
  return { bytes, files };
}

/**
 * Run one dev-team turn for one ticket.
 *
 * The order is the safety property: open the patch (which enforces "one team at a time"), fingerprint
 * the tree, run the turn, fingerprint again, and hand the result to `recordProposal` — the only door
 * from a dev turn to a patch record. `recordProposal` re-runs the banned-path list, the proposal
 * contract, the declared-vs-actual cross-check and the test-chain comparison, so no path through this
 * module produces a patch that skipped them.
 *
 * @param {Object} input
 * @param {string} input.ticketId
 * @param {string} input.seriesDir
 * @param {string} [input.root]
 * @param {{json: string, markdown: string}} [input.patchPaths]
 * @param {string} [input.ticketsFile]
 * @returns {Promise<{ok: boolean, patch: Object|null, problems: Object[], warnings: Object[], writeAttempts: Object[], actualChanges: string[], usage: Object|null, turnShape: Object|null, error: string|null}>}
 */
async function workTicket({ ticketId, seriesDir, root = ROOT, patchPaths = patches.patchPaths(), ticketsFile = tickets.ticketPaths().json }) {
  const fail = (error, extra = {}) => ({
    ok: false,
    patch: null,
    problems: [],
    warnings: [],
    writeAttempts: [],
    actualChanges: [],
    usage: null,
    turnShape: null,
    error,
    ...extra,
  });

  const store = tickets.readTickets(ticketsFile);
  const ticket = store.tickets.find((t) => t.id === ticketId);
  if (!ticket) {
    return fail(
      `no ticket ${ticketId} in ${ticketsFile}. Run "node diagnose.js --open" to list the tickets that ` +
        `have been answered, and "npm run delivery" to see which ones needed asking.`
    );
  }

  // Before anything else: what the tree already looks like, and what the test chain already runs. Read
  // here rather than compared later, because "what did this patch change?" has to be answered against
  // the state the turn started from — and because a turn that starts from a tree somebody else already
  // edited cannot be described afterwards, which is the whole basis on which the manager judges it.
  const treeBefore = patches.workingTreeChanges(root);
  if (treeBefore.error) return fail(treeBefore.error);
  const chainBefore = patches.readTestChain(root);
  if (chainBefore.error) return fail(chainBefore.error);
  if (treeBefore.files.length) {
    return fail(
      `the working tree inside ${root} already holds ${treeBefore.files.length} change(s) no patch ` +
        `declares: ` +
        `${treeBefore.files.slice(0, 12).map((f) => `${f.status} ${f.path}`).join(", ")}. A dev turn has ` +
        `to start from a tree it can describe, or every file the turn touches arrives mixed with edits ` +
        `nobody named and the manager cannot tell which is which. Put them back, or commit them, first.`
    );
  }

  // The door. Every refusal `createPatch` makes — no diagnosis, no choice, an option that does not
  // need code, a ticket whose every option was refused, a second team — is a refusal of THIS command,
  // and it happens before a model is reached.
  const opened = patches.createPatch({ ticketId, paths: patchPaths, ticketsFile });
  if (!opened.patch) return fail(opened.error);
  const patch = opened.patch;
  const option = (ticket.options || []).find((o) => o.id === patch.optionId);
  if (!option) return fail(`option ${patch.optionId} is no longer on ticket ${ticketId}.`);

  const footprint = await evidenceFootprint(ticket, [], seriesDir, root);
  // The evidence size is PRINTED, not spent on a cap. This turn is uncapped, so the number that
  // explains a long dev turn afterwards is "how much it was pointed at", and the run log is where the
  // account owner reads it.
  harness.logLine(
    `[devteam] ${ticket.id}: evidence is ${footprint.files.length} file(s), ` +
      `${footprint.bytes} bytes — uncapped turn, old read answers offloaded to disk as it fills`
  );

  const gate = await patchFsTools({ cwd: root, allowedDirs: [root] });

  // `pre-manager` / `post-manager` fire HERE, around the turn, not in the CLI that typed the command.
  // Every refusal this module makes (unknown ticket, a tree somebody else already edited, a ticket
  // with no chosen option, a second team on one ticket) happens first, so a request that never reaches
  // the model never pays for a container switch (gotcha 22). And this turn is a tool-calling agent
  // that EDITS files, which a container that cannot call tools answers with nothing at all (gotcha
  // 51) — so the guarantee "the support model is the one serving" belongs to the role that makes the
  // call. Which container that is stays entirely the hook's business (AGENTS.md §3).
  let result = null;
  let turnError = null;
  try {
    result = await runTurnWithHooks(MANAGER_TASK, async () => {
      const agent = await harness.createAgentHandle({
        name: "devteam",
        systemPrompt: loadSystemPrompt() + DEVTEAM_TOOLS_NOTE,
        tools: gate.tools,
        approve: gate.approve,
        cwd: root,
        // The delivery-layer context management: no step cap, the working window is reported on every
        // tool answer, and old read answers are set aside on disk where they stay recallable
        // (`utils/context.js`). The harness adds `manage_context` / `recall_memory` to the tool set for
        // a managed role — this module does not add them itself, so the write gate still judges exactly
        // the five file tools the banned-path table is written against (gotcha 75), and the two memory
        // tools come in through the harness rather than as paths the sandbox was asked to approve.
        contextManagement: true,
      });
      try {
        const reply = await agent.sendTurn(renderTicketForDev({ ticket, patch, option, seriesDir, root }), {
          label: `devteam-${ticket.id}`,
        });
        assertRealToolCalls(reply, "the dev team", ticket.volume || ticket.step);
        return reply;
      } finally {
        await agent.close();
      }
    });
  } catch (err) {
    // A turn that died part-way is not a clean refusal: the patch is already open and the tree may
    // already be edited. Report it as an unfinished patch, because that is what the next command has
    // to deal with, and name the way back. A `pre-manager` hook that failed lands here too — the
    // patch is open and unjudged either way, and the tree is what it is.
    turnError = err;
  }

  const treeAfter = patches.workingTreeChanges(root);
  if (treeAfter.error) return fail(treeAfter.error, { patch });
  const chainAfter = patches.readTestChain(root);

  const actualChanges = treeAfter.files.map((f) => f.path);
  const attempts = collectPatchWriteAttempts(gate.refusals, result?.toolCalls || [], gate.advertised);
  const unfinished = (what) =>
    `${what} ${actualChanges.length} file(s) inside ${root} are changed in the working tree ` +
    `(${actualChanges.join(", ") || "none"}). Patch ${patch.id} is still unjudged, so act mode will ` +
    `refuse to run a step. Run "npm run fix -- --revert=${patch.id}" to put the tree back.`;

  if (turnError) {
    return {
      ok: false,
      patch,
      problems: [{ kind: "turn-failed", message: turnError.message }],
      warnings: [],
      writeAttempts: attempts,
      actualChanges,
      usage: null,
      // No turn record: the turn threw before the harness handed one back, so the honest value is
      // "unknown", not a row of zeroes that reads like the turn made no tool calls.
      turnShape: null,
      error: unfinished(`the dev turn did not finish (${turnError.message}).`) +
        " The turn's own record is in .logs/ — read it before re-running, because a turn stopped for " +
        "repeating itself or for running past the turn clock is a different problem from a turn that " +
        "answered nothing, and this turn has no step limit to blame.",
    };
  }

  const parsed = parseProposalReply(result.text);
  if (!parsed.proposal) {
    // No proposal, but the tree may already be changed. Say so, and say what is sitting in it.
    return {
      ok: false,
      patch,
      problems: parsed.problems,
      warnings: [],
      writeAttempts: attempts,
      actualChanges,
      usage: result.usage || null,
      turnShape: turnShapeOf(result),
      error: unfinished("the dev team produced no proposal."),
    };
  }

  // The only door from a dev turn to a patch record.
  const written = patches.recordProposal(
    patch.id,
    {
      files: parsed.proposal.files,
      summary: parsed.proposal.summary,
      why: parsed.proposal.why,
      couldBreak: parsed.proposal.couldBreak,
      expected: parsed.proposal.expected,
      verify: parsed.proposal.verify,
      questions: parsed.proposal.questions,
      ownerNote: parsed.proposal.ownerNote,
      actualChanges,
      refusedWrites: attempts,
      chain: { before: chainBefore.script, after: chainAfter.script },
      usage: result.usage || null,
      turnShape: turnShapeOf(result),
    },
    patchPaths
  );

  const stored = written.patch || patch;
  return {
    ok: !written.error,
    patch: stored,
    problems: written.problems,
    warnings: written.warnings,
    writeAttempts: attempts,
    actualChanges,
    usage: result.usage || null,
    turnShape: turnShapeOf(result),
    error: written.error || null,
  };
}

/**
 * Run the pinned checks against a patch. The CLI runs them; the team does not get to say it ran them.
 *
 * @param {string} patchId
 * @param {{root?: string, patchPaths?: {json: string, markdown: string}}} [opts]
 * @returns {{patch: Object|null, verdict: Object, error: string|null}}
 */
function verifyPatch(patchId, { root = ROOT, patchPaths = patches.patchPaths() } = {}) {
  const ran = patches.runChecks({ root });
  return patches.recordChecks(patchId, ran, patchPaths);
}

/**
 * Read the system prompt for the role. Fails loudly rather than coding with no brief.
 * @returns {string}
 */
function loadSystemPrompt() {
  let text;
  try {
    text = fs.readFileSync(SYSTEM_PROMPT_FILE, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read ${SYSTEM_PROMPT_FILE}: ${err.message}. The dev team's brief is not optional — a ` +
        `role with write access and no instructions is the most expensive kind of bug this project has.`
    );
  }
  if (!text.trim()) {
    throw new Error(`${SYSTEM_PROMPT_FILE} is empty.`);
  }
  return text.trim();
}

/**
 * The patch as a human-readable line for the CLI's summary. The manager reads `patches.md` for the
 * detail; this is the "what just happened" line.
 *
 * @param {Object} patch
 * @returns {string}
 */
function describePatch(patch) {
  const parts = [`${patch.id} (${patch.status})`, `ticket ${patch.ticketId}`, `${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""}`];
  if ((patch.files || []).length) parts.push(`${patch.files.length} file(s): ${patch.files.join(", ")}`);
  if (patch.checkVerdict) {
    parts.push(
      patch.checkVerdict.accepted
        ? "checks green"
        : `checks not green${patch.checkVerdict.missing.length ? ` (not run: ${patch.checkVerdict.missing.join(", ")})` : ""}${patch.checkVerdict.failed.length ? ` (failed: ${patch.checkVerdict.failed.join(", ")})` : ""}`
    );
  }
  return parts.join(" | ");
}

module.exports = {
  ROOT,
  DEVTEAM_TOOLS_NOTE,
  DELETION_REFUSAL,
  patchFsTools,
  collectPatchWriteAttempts,
  parseProposalReply,
  renderTicketForDev,
  evidenceFootprint,
  workTicket,
  verifyPatch,
  describePatch,
  loadSystemPrompt,
};
