/**
 * test/test-patches.js — the patch channel: the only way a code change enters this pipeline, and the
 * rules that stop the role making that change from editing the rules that judge it.
 *
 * `npm run delivery --mode=act` gives a manager authority over a run without ever letting it read the
 * code (AGENTS.md §3.6). When re-running stops working it opens a ticket, the diagnostics team answers
 * it, and the manager chooses an option. If the chosen option says `requiresCodeChange`, a dev team is
 * called in — and that is the first role in this pipeline that can change the code deciding what is
 * allowed. So the channel has to be built before the role is (gotcha 66: a running process cannot pick
 * up a code change, so the working tree of `main` IS the code the next run executes).
 *
 * Six things are pinned here, and each one is a rule that would otherwise live only in a prompt:
 *
 *   1. **Some files a patch may not touch, and a refusal names WHICH rule it hit.** The constraint
 *      tables, the tests that pin them, `hooks/`, `.env`, the machine state, and the corpus. A refusal
 *      that only says "not allowed" is the refusal a reader routes around.
 *   2. **The project-source test is a whitelist.** `ai-client/` holds generated output as well as code,
 *      so "allowed unless listed" would default to editing the run's own evidence.
 *   3. **The gate's own commands are pinned and RUN.** `REQUIRED_CHECKS` is executed by this module,
 *      the command recorded is taken from the table rather than from the caller, and a caller cannot
 *      point the runner at a softer command. `npm test` is a list, and a list is the thing a patch
 *      could shorten — so the chain itself is checked too.
 *   4. **A patch shows its changes.** A file that changed without being named is refused, not reported
 *      later. A file named that did not change is a warning (gotcha 74's two-directional honesty).
 *   5. **A proposal argues in the units the acceptance test measures.** Naming a scoreboard of its own
 *      is refused; an outcome-only check is flagged, not hidden.
 *   6. **The manager accepts or rejects; only the dev team commits, and the commit stages exactly the
 *      declared files.** `git add -A` is never used in this repository: the working tree outside
 *      `ai-client/` is the account owner's in-progress translation output.
 *
 * No live endpoint and no model call: this suite is the channel itself. The git scenarios run against
 * throwaway `git init` fixtures, because `commitPatch` and `revertPatch` are only real if they touch a
 * real repository — and the real repository is the one holding the corpus they must not touch
 * (gotcha 69). Every fixture has its own `POSTMORTEM_DIR`.
 */
const assert = require("assert");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const TMP = path.join(os.tmpdir(), "oresuki-patches-test");
process.env.POSTMORTEM_DIR = path.join(TMP, "postmortem");
process.env.RESEARCH_ENABLED = "false";

const patches = require("../utils/patches");
const tickets = require("../utils/tickets");

const SERIES = "Owaresuki";

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * A ticket that has been diagnosed and answered, and the patch its chosen option opens.
 *
 * The ticket is the volume-15 shape from gotcha 68, because that is the incident every rule in this
 * channel was written against: a gate quarantining a glossary that had GROWN, and the cheapest available
 * answer being the guard being switched off.
 *
 * @param {string} label
 * @param {{diagnosis?: Object, choose?: "code"|"deliverable"}} [opts]
 */
async function openChannel(label, { diagnosis = GOOD_DIAGNOSIS, choose = "code", ticketPaths: shared, ticketExtra = {} } = {}) {
  const dir = path.join(TMP, label);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  // Ticket ids are `TCK-<run>-<n>`, numbered inside one ticket file, so two channels that are meant to
  // be two tickets in the same run share one ticket file — the way the real channel works.
  const ticketPaths = shared || { json: path.join(dir, "tickets.json"), markdown: path.join(dir, "tickets.md") };
  await fs.mkdir(path.dirname(ticketPaths.json), { recursive: true });
  const patchPaths = { json: path.join(dir, "patches.json"), markdown: path.join(dir, "patches.md") };

  const created = tickets.createTicket(fixtureTicket(ticketExtra), ticketPaths);
  assert.ok(!created.error, created.error);
  const answered = tickets.recordDiagnosis(created.ticket.id, diagnosis, ticketPaths);
  assert.ok(!answered.error, answered.error);

  const wanted = choose === "code" ? (o) => o.requiresCodeChange : (o) => !o.requiresCodeChange;
  const option = answered.ticket.options.find(wanted);
  assert.ok(option, `no ${choose} option survived the filter`);
  const chosen = tickets.recordChoice(created.ticket.id, {
    optionId: option.id,
    reason:
      choose === "code"
        ? "the glossary grew, so the guard is refusing good work; the fix belongs in how the guard reads a row"
        : "the term rows are the deliverable, and adding a duplicate row is a judgment about the book",
  }, ticketPaths);
  assert.ok(!chosen.error, chosen.error);

  const opened = patches.createPatch({
    ticketId: created.ticket.id,
    paths: patchPaths,
    ticketsFile: ticketPaths.json,
  });
  return { dir, ticketPaths, patchPaths, ticket: created.ticket, option, opened };
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
      label: "Teach the gate to read a rename as carried forward",
      touches: ["glossary.js compareGlossaryCarryForward"],
      cost: "medium",
      risk: "a real deletion whose row is mentioned in another row's Notes could pass",
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
    {
      label: "Turn off the glossary carry-forward guard for volume 15",
      touches: ["GLOSSARY_CARRY_FORWARD_GUARD"],
      cost: "free",
      risk: "nothing checks the cumulative invariant any more",
      verify: "the volume is accepted",
    },
  ],
  recommend: "Teach the gate to read a rename as carried forward — it is the only option that changes the deliverable.",
  questions: [],
  read: ["glossary.js"],
  ownerNote: "The guard reported a real change correctly. It is not the fault.",
};

/** Every option on this diagnosis is banned, so the ticket has nothing the manager may choose. */
const ALL_REFUSED_DIAGNOSIS = {
  cause:
    "The carry-forward gate compares term columns as exact strings, so a row reconciled into one " +
    "canonical spelling reads as a deletion. That is a rule about the code, and every move that would " +
    "clear the finding without changing the code is a guard being removed.",
  options: [
    {
      label: "Turn off the glossary carry-forward guard for volume 15",
      touches: ["GLOSSARY_CARRY_FORWARD_GUARD"],
      cost: "free",
      risk: "nothing checks the cumulative invariant any more",
      verify: "the volume is accepted",
      requiresCodeChange: true,
    },
    {
      label: "Delete the quarantined file so the volume stops being reported",
      touches: [`series/${SERIES}(15)/glossary.md.rejected`],
      cost: "free",
      risk: "the evidence that would have explained the incident is gone",
      verify: "the report stops naming volume 15",
      requiresCodeChange: true,
    },
  ],
  recommend: "Turn off the glossary carry-forward guard for volume 15.",
  questions: [],
  read: ["glossary.js"],
  ownerNote: "If the account owner wants volume 15 shipped without the guard, that is their call, in writing.",
};

/**
 * A proposal that satisfies the contract. `actualChanges` is what the working tree reports — the real
 * caller (utils/devteam.js) fingerprints the tree before and after the dev turn and passes that here.
 */
function goodProposal(extra = {}) {
  return {
    files: ["glossary.js", "utils/prompt.js"],
    summary:
      "compareGlossaryCarryForward now treats an entry as carried when the row it moved into records " +
      "the older spelling anywhere in that row, and reports it as renamed rather than dropped.",
    why:
      "The amend prompt tells the agent to reconcile two spellings into one canonical row and note the " +
      "change. The gate only read the term column, so the edit the prompt asked for was the edit the " +
      "gate called a loss.",
    couldBreak:
      "A real deletion whose row happens to be mentioned in another row's Notes could now pass. The " +
      "rename test is limited to rows carrying no other carried-forward term to keep that window narrow.",
    expected: [
      { signal: "glossaryTerms", direction: "up", why: "volume 15's snapshot is no longer quarantined, so its rows are counted" },
      { signal: "stepsBuilt", direction: "up", why: "glossary stops failing volume 15, so volumes 15-17 get their declared output" },
    ],
    verify: "the term-row count in the series glossary and the volume 15 folder listing after a rebuild",
    questions: [],
    ownerNote: "",
    actualChanges: ["glossary.js", "utils/prompt.js"],
    usage: { input: 1200, output: 300 },
    // How the dev turn actually ran. This role has no step cap any more, so the
    // record carries the SHAPE of the turn instead of a limit it never had
    // (`turnShapeOf` in utils/agents.js) — and the report prints the harness's own
    // ending word rather than softening it.
    turnShape: {
      chunks: 2,
      toolCalls: 14,
      offloads: 1,
      offloadedTokens: 9100,
      compactions: 0,
      endedAs: "complete",
    },
    ...extra,
  };
}

const GREEN_CHECKS = () =>
  patches.REQUIRED_CHECKS.map((c) => ({ id: c.id, exitCode: 0, tail: "ok", at: new Date().toISOString() }));

const GOOD_ACCEPT_REASON =
  "the term rows the guard was refusing to publish are the deliverable, and the rename test stays narrow";

/** Run git inside a fixture repository. */
function git(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A throwaway repository with a committed base state.
 *
 * `commitPatch` and `revertPatch` are only worth testing against a real repository — and the real one
 * holds the corpus this channel must never touch, so the fixture is its own `git init` (gotcha 69).
 */
async function gitFixture(label) {
  const root = path.join(TMP, label);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, "utils"), { recursive: true });
  await fs.writeFile(path.join(root, "glossary.js"), "export const gate = \"exact-string\";\n", "utf8");
  await fs.writeFile(path.join(root, "utils/prompt.js"), "export const truncate = \"whole-cell\";\n", "utf8");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "patch-fixture", version: "1.0.0" }, null, 2) + "\n", "utf8");
  git(["init", "-q", "-b", "main"], root);
  // The identity lives in the fixture's own config, so the git calls `commitPatch` makes inherit it.
  git(["config", "user.email", "patch-fixture@example.invalid"], root);
  git(["config", "user.name", "Patch Fixture"], root);
  git(["config", "commit.gpgsign", "false"], root);
  git(["add", "--", "."], root);
  git(["commit", "-q", "-m", "fixture base"], root);
  return root;
}

async function patchDirFor(label) {
  const dir = path.join(TMP, `${label}-patches`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return { json: path.join(dir, "patches.json"), markdown: path.join(dir, "patches.md") };
}

// ─── 1. The banned diff names the rule it hit ─────────────────────────────────

/**
 * The order of the checks is the whole point. A catch-all corpus rule evaluated first would report
 * `hooks/pre-glossary.sh` as "corpus", which is both the wrong reason and a refusal nobody can argue
 * with (gotcha 71: a refusal that does not name its reason just looks like caution).
 */
async function scenarioBannedPathsNameTheirRule() {
  const banned = [
    ["utils/tickets.js", "constraint-tables"],
    ["utils/patches.js", "constraint-tables"],
    // A guard module's SPLIT LAYER is the guard: `utils/patches.js` is the cover of the
    // book, and the table that decides what this team may touch lives inside it.
    ["utils/patches/rules.js", "constraint-tables"],
    ["utils/tickets/banned-options.js", "constraint-tables"],
    ["utils/resume/menu.js", "constraint-tables"],
    ["test/test-tickets.js", "constraint-tests"],
    ["test/test-patches.js", "constraint-tests"],
    ["hooks/pre-glossary.sh", "edit-hooks"],
    ["hooks/README.md", "edit-hooks"],
    [".env", "edit-env"],
    [".env.example", "edit-env"],
    [".postmortem/ledger.json", "edit-machine-state"],
    [".logs/run-1/summary.log", "edit-machine-state"],
    [".dry-run/glossary-15.md", "edit-machine-state"],
    ["node_modules/ai/index.js", "edit-machine-state"],
    // The corpus catch-all, and the generated-artifact spellings inside `ai-client/` itself.
    ["test-series/test_story(1)/glossary.md", "edit-corpus"],
    ["test_story(15)/glossary.md.rejected", "edit-corpus"],
    ["test_story(01)/translation-ch1.rejected-passage.md", "edit-corpus"],
    ["glossary.md.provenance.json", "edit-corpus"],
    ["character-voice-rolling-state.json", "edit-corpus"],
    ["test_story(01)/book-bundle.meta.json", "edit-corpus"],
    // A path that cannot be normalised to project-relative is BANNED, not allowed: `../` is how a
    // patch reaches the folder the account owner told everyone not to touch.
    ["../old (do not touch)/x.md", "path-outside-project"],
    ["~/outside.md", "path-outside-project"],
    ["/etc/passwd", "path-outside-project"],
    ["utils/../hooks/pre-translate.sh", "path-outside-project"],
  ];
  for (const [file, rule] of banned) {
    const verdict = patches.patchPathIsBanned(file);
    assert.ok(verdict.banned, `${file} should be banned`);
    assert.strictEqual(verdict.rule.id, rule, `${file} reported ${verdict.rule && verdict.rule.id}, expected ${rule}`);
    assert.ok(verdict.rule.because.length > 20, `${rule} has no reason`);
    assert.match(verdict.rule.escalateTo, /account owner/, `${rule} does not name the account owner`);
  }

  // The false-positive half (gotcha 65): a filter that refuses everything is the filter that gets
  // switched off. `system-prompts/glossary.md` is the file the old corpus regex used to match, and it
  // is a legitimate patch target — gotcha 68's fix is a prompt edit plus a gate edit.
  const allowed = [
    "system-prompts/glossary.md",
    "user-prompts/glossary-feedback.md",
    "glossary.js",
    "utils/prompt.js",
    "utils/translate.js",
    "configs/shared.js",
    "AGENTS.md",
    "package.json",
    "test/test-glossary-load.js",
    "test/fake-workflow.js",
    // The git form of a path (what `git status` prints from the repository root) resolves the same way.
    "ai-client/glossary.js",
  ];
  for (const file of allowed) {
    const verdict = patches.patchPathIsBanned(file);
    assert.ok(!verdict.banned, `${file} should be allowed, reported ${verdict.rule && verdict.rule.id}`);
  }
}

async function scenarioProjectSourceIsAWhitelist() {
  // `ai-client/` holds generated output as well as code, so "allowed unless listed" would default to
  // editing the run's own evidence. The test is: is this project source? not: is this on a list?
  assert.strictEqual(patches.isProjectSourcePath("utils/prompt.js"), true);
  assert.strictEqual(patches.isProjectSourcePath("index.js"), true);
  assert.strictEqual(patches.isProjectSourcePath("AGENTS.md"), true);
  assert.strictEqual(patches.isProjectSourcePath("system-prompts/glossary.md"), true);
  assert.strictEqual(patches.isProjectSourcePath("test/calibration/cases.json"), true);
  assert.strictEqual(patches.isProjectSourcePath("test_story(15)/glossary.md"), false);
  assert.strictEqual(patches.isProjectSourcePath("test-series/test_story(1)/wiki.md"), false);
  assert.strictEqual(patches.isProjectSourcePath("images/plate-01.png"), false);

  // The corpus test keys on the generated spellings, NOT on artifact basenames: `glossary.md` on its
  // own is the prompt file's neighbour, and the old regex matched `system-prompts/glossary.md`.
  assert.strictEqual(patches.corpusIsNamedArtifact("system-prompts/glossary.md"), false);
  assert.strictEqual(patches.corpusIsNamedArtifact("glossary.md"), false);
  assert.strictEqual(patches.corpusIsNamedArtifact("test_story(15)/glossary.md.rejected"), true);
  assert.strictEqual(patches.corpusIsNamedArtifact("series/glossary.md.provenance.json"), true);
}

async function scenarioAnswerKeyIsFlaggedNotBanned() {
  // Not banned: a scripted answer and a calibration pair are legitimately part of the project, and a
  // patch that fixes a real bug may legitimately reach them. What is not legitimate is doing it
  // quietly — so it must be named in `couldBreak`, and the report prints it.
  const touched = patches.patchTouchesAnswerKey(["test/fake-workflow.js", "test/calibration/cases.json", "glossary.js"]);
  assert.deepStrictEqual(touched.map((t) => t.file), ["test/fake-workflow.js", "test/calibration/cases.json"]);
  assert.strictEqual(patches.patchPathIsBanned("test/fake-workflow.js").banned, false);

  const { patchPaths, opened } = await openChannel("answer-key");
  assert.ok(!opened.error, opened.error);
  const recorded = patches.recordProposal(
    opened.patch.id,
    goodProposal({ files: ["test/fake-workflow.js"], actualChanges: ["test/fake-workflow.js"], expected: [{ signal: "published", direction: "up", why: "the fixture's chapter publishes" }] }),
    patchPaths
  );
  assert.deepStrictEqual(recorded.problems, [], JSON.stringify(recorded.problems));
  assert.ok(recorded.warnings.some((w) => w.kind === "answer-key-touched"), JSON.stringify(recorded.warnings));
  const md = fsSync.readFileSync(patchPaths.markdown, "utf8");
  assert.ok(/fake-workflow\.js/.test(md), md);
}

// ─── 2. The gate's own commands ───────────────────────────────────────────────

async function scenarioTestChainCannotBeShortened() {
  const chain = patches.readTestChain(patches.ROOT);
  assert.ok(!chain.error, chain.error);
  const intact = patches.testChainIsIntact(chain.script, chain.script);
  assert.strictEqual(intact.ok, true);

  // Dropping a suite from the chain is the move the banned-path list alone cannot see: a patch does
  // not have to name `package.json` to make a suite stop running — but it does have to name it to
  // change the chain, and either way this catches it.
  const dropped = patches.testChainIsIntact(chain.script, chain.script.replace("node test/test-patches.js && ", ""));
  assert.strictEqual(dropped.ok, false, JSON.stringify(dropped));
  assert.ok(dropped.removed.some((f) => f.includes("test-patches")), JSON.stringify(dropped.removed));

  // Adding one is fine, and it is reported so the account owner can see the gate grew.
  const grown = patches.testChainIsIntact(chain.script, `${chain.script} && node test/test-new.js`);
  assert.strictEqual(grown.ok, true);
  assert.deepStrictEqual(grown.added, ["test/test-new.js"]);

  // The chain this repository actually has includes the patch channel's own suite.
  assert.ok(/test-patches\.js/.test(chain.script), "test/test-patches.js is not in the npm test chain");
}

async function scenarioChecksArePinnedOnTheWayIn() {
  // An id that is not on the pinned table is dropped, and `judgeChecks` then reports it as missing —
  // a check that is not on the list is not a check.
  const softened = patches.normalizeChecks([
    { id: "npm-test", command: "node -e 0", args: [], exitCode: 0 },
    { id: "my-own-gate", command: "echo ok", exitCode: 0 },
  ]);
  assert.strictEqual(softened.length, 1);
  assert.strictEqual(softened[0].command, "npm test", "the recorded command came from the caller, not the table");
  const verdict = patches.judgeChecks(softened);
  assert.strictEqual(verdict.accepted, false);
  assert.deepStrictEqual(verdict.missing, ["pipeline-loop"]);

  // `passed` is derived from the exit code, never from the caller's claim.
  const claimed = patches.normalizeChecks([{ id: "npm-test", exitCode: 1, passed: true }, { id: "pipeline-loop", exitCode: 0, passed: true }]);
  assert.strictEqual(claimed[0].passed, false, "a caller cannot assert its own check passed");
  assert.strictEqual(patches.judgeChecks(claimed).accepted, false);

  // A check that never ran is reported as never ran, not as a failure with a mystery exit code.
  const never = patches.judgeChecks([{ id: "npm-test", exitCode: null, passed: false }, { id: "pipeline-loop", exitCode: 0, passed: true }]);
  assert.deepStrictEqual(never.failed, ["npm-test did not run"]);

  // The runner cannot be pointed at a softer command than the pinned one: the id is looked up in the
  // table and the PINNED command is what executes. Run in a folder with no package.json, so the real
  // `npm test` fails fast — and the record says `npm test`, not the `echo` this caller asked for.
  const ran = patches.runChecks({ root: TMP, checks: [{ id: "npm-test", command: "echo", args: ["ok"] }] });
  assert.strictEqual(ran.length, 1);
  assert.strictEqual(ran[0].command, "npm test");
  assert.strictEqual(ran[0].passed, false, "the pinned command ran, and it did not pass here — which is the point");
  assert.strictEqual(patches.runChecks({ root: TMP, checks: [{ id: "made-up" }] }).length, 0, "an unpinned id is not run at all");
}

// ─── 3. The door ──────────────────────────────────────────────────────────────

async function scenarioAPatchAnswersAChosenOption() {
  const dir = path.join(TMP, "door");
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const ticketPaths = { json: path.join(dir, "tickets.json"), markdown: path.join(dir, "tickets.md") };
  const patchPaths = await patchDirFor("door-patches");

  // No ticket, no way in.
  const nowhere = patches.createPatch({ ticketId: "TCK-nope-1", paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.strictEqual(nowhere.patch, null);
  assert.match(nowhere.error, /no ticket/, nowhere.error);

  // A ticket nobody has answered yet.
  const bare = tickets.createTicket(fixtureTicket(), ticketPaths);
  const premature = patches.createPatch({ ticketId: bare.ticket.id, paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.match(premature.error, /no diagnosis yet/, premature.error);

  // Answered, but the manager has not chosen.
  tickets.recordDiagnosis(bare.ticket.id, GOOD_DIAGNOSIS, ticketPaths);
  const unchosen = patches.createPatch({ ticketId: bare.ticket.id, paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.match(unchosen.error, /no recorded choice/, unchosen.error);

  // Chosen — and now the option itself is checked. A move the manager was already allowed to make does
  // not get a code change paid for it.
  const freeOption = tickets.recordDiagnosis(bare.ticket.id, GOOD_DIAGNOSIS, ticketPaths).ticket.options.find((o) => !o.requiresCodeChange);
  tickets.recordChoice(bare.ticket.id, { optionId: freeOption.id, reason: "the term rows are the deliverable" }, ticketPaths);
  const free = patches.createPatch({ ticketId: bare.ticket.id, paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.match(free.error, /does not need a code change/, free.error);

  // A ticket whose every option was refused belongs to the account owner, and a dev team cannot be
  // sent to do the account owner's job.
  const ownerTicket = tickets.createTicket(fixtureTicket({ question: "What should happen to volume 15's glossary?" }), ticketPaths);
  const allRefused = tickets.recordDiagnosis(ownerTicket.ticket.id, ALL_REFUSED_DIAGNOSIS, ticketPaths);
  assert.strictEqual(allRefused.ticket.noUsableOptions, true, JSON.stringify(allRefused.ticket.noUsableOptions));
  const ownerChoice = tickets.recordChoice(ownerTicket.ticket.id, { optionId: "O1", reason: "whatever is cheapest" }, ticketPaths);
  assert.match(ownerChoice.error, /no option left to choose/, ownerChoice.error);
  assert.match(ownerChoice.error, /account owner/, ownerChoice.error);
  const summoned = patches.createPatch({ ticketId: ownerTicket.ticket.id, paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.match(summoned.error, /belongs to the account owner/, summoned.error);

  // A closed ticket has an answer already.
  const closed = tickets.createTicket(fixtureTicket(), ticketPaths);
  tickets.recordDiagnosis(closed.ticket.id, GOOD_DIAGNOSIS, ticketPaths);
  const closedCode = tickets.recordDiagnosis(closed.ticket.id, GOOD_DIAGNOSIS, ticketPaths).ticket.options.find((o) => o.requiresCodeChange);
  tickets.recordChoice(closed.ticket.id, { optionId: closedCode.id, reason: "the term rows are the deliverable" }, ticketPaths);
  const closedNow = tickets.closeTicket(closed.ticket.id, { outcome: "improved", reason: "the series glossary holds 460 term rows after the rebuild" }, ticketPaths);
  assert.ok(!closedNow.error, closedNow.error);
  const late = patches.createPatch({ ticketId: closed.ticket.id, paths: patchPaths, ticketsFile: ticketPaths.json });
  assert.strictEqual(late.patch, null, "a closed ticket must not open a patch");
  assert.match(late.error, /is closed/, late.error);

  // The real door: a chosen option that needs code.
  const live = await openChannel("door-live");
  assert.ok(!live.opened.error, live.opened.error);
  assert.strictEqual(live.opened.patch.status, "proposed");
  assert.strictEqual(live.opened.patch.ticketId, live.ticket.id);
  assert.strictEqual(live.opened.patch.optionId, live.option.id);
  assert.strictEqual(live.opened.patch.optionLabel, live.option.label);
  assert.strictEqual(live.opened.patch.step, "glossary");
  assert.strictEqual(live.opened.patch.volume, "15");
  assert.strictEqual(live.opened.patch.finding, "quarantine-present");
  // The manager's reason travels with the patch, so the account owner reads the choice and the
  // judgment in one place.
  assert.match(live.opened.patch.chosenReason, /how the guard reads a row/, live.opened.patch.chosenReason);

  // Naming a different option after the choice is not how this works.
  const other = await openChannel("door-other");
  const wrong = patches.createPatch({
    ticketId: other.ticket.id,
    optionId: "O2",
    paths: other.patchPaths,
    ticketsFile: other.ticketPaths.json,
  });
  assert.match(wrong.error, /was not the one chosen/, wrong.error);
}

async function scenarioOneTeamAtATime() {
  const sharedDir = path.join(TMP, "one-tickets");
  await fs.rm(sharedDir, { recursive: true, force: true });
  await fs.mkdir(sharedDir, { recursive: true });
  const sharedTickets = { json: path.join(sharedDir, "tickets.json"), markdown: path.join(sharedDir, "tickets.md") };

  const first = await openChannel("one-first", { ticketPaths: sharedTickets });
  assert.ok(!first.opened.error, first.opened.error);

  // A second patch on the same ticket: two unjudged changes in one working tree cannot be judged
  // separately.
  const again = patches.createPatch({
    ticketId: first.ticket.id,
    paths: first.patchPaths,
    ticketsFile: first.ticketPaths.json,
  });
  assert.match(again.error, /already has PATCH-001/, again.error);
  assert.match(again.error, /One team at a time/, again.error);

  // A patch on a DIFFERENT ticket, while the first is still unjudged, is refused for the same reason:
  // the working tree is what the next run executes.
  const second = await openChannel("one-second", { ticketPaths: sharedTickets, ticketExtra: { volume: "16" } });
  assert.ok(!second.opened.error, second.opened.error);
  assert.notStrictEqual(second.ticket.id, first.ticket.id);
  const blocked = patches.createPatch({
    ticketId: second.ticket.id,
    paths: first.patchPaths,
    ticketsFile: second.ticketPaths.json,
  });
  assert.strictEqual(blocked.patch, null);
  assert.match(blocked.error, /already in the/, blocked.error);
  assert.match(blocked.error, /Accept or reject PATCH-001 first/, blocked.error);

  // Rejecting the first one opens the door again.
  patches.recordProposal(first.opened.patch.id, goodProposal(), first.patchPaths);
  const rejected = patches.rejectPatch(first.opened.patch.id, { reason: "the proposal does not say which row carries the fix" }, first.patchPaths);
  assert.ok(!rejected.error, rejected.error);
  assert.deepStrictEqual(patches.pendingPatches(first.patchPaths), [], "a rejected patch is judged, so it is no longer pending");
  assert.strictEqual(patches.readPatches(first.patchPaths.json).patches.length, 1);
}

// ─── 4. The proposal ──────────────────────────────────────────────────────────

async function scenarioAProposalIsCheckedBeforeItIsAttached() {
  const { patchPaths, opened } = await openChannel("proposal");
  assert.ok(!opened.error, opened.error);

  const bad = patches.recordProposal(
    opened.patch.id,
    {
      files: ["utils/tickets.js", "glossary.js"],
      summary: "fixed it",
      why: "",
      couldBreak: "",
      expected: [{ signal: "termCount", direction: "sideways", why: "" }],
      verify: "the finding disappears",
      actualChanges: ["utils/prompt.js"],
    },
    patchPaths
  );
  const kinds = bad.problems.map((p) => p.kind);
  assert.ok(kinds.includes("missing-field"), JSON.stringify(kinds));
  assert.ok(kinds.includes("banned-path"), JSON.stringify(kinds));
  assert.ok(kinds.includes("unknown-signal"), JSON.stringify(kinds));
  assert.ok(kinds.includes("undeclared-change"), JSON.stringify(kinds));
  const warned = bad.warnings.map((w) => w.kind);
  assert.ok(warned.includes("thin-summary"), JSON.stringify(warned));
  assert.ok(warned.includes("outcome-only-verification"), JSON.stringify(warned));
  assert.ok(warned.includes("declared-but-unchanged"), JSON.stringify(warned));

  // The refusal is recorded, and it names the rule and the escalation.
  const stored = patches.findPatch(opened.patch.id, patches.readPatches(patchPaths.json).patches);
  assert.strictEqual(stored.summary, undefined, "a refused proposal is not attached");
  assert.strictEqual(stored.status, "proposed");
  assert.ok((stored.refusedPaths || []).some((b) => b.file === "utils/tickets.js" && /account owner/.test(b.escalateTo)), JSON.stringify(stored.refusedPaths));

  // A direction that is not the signal table's own words.
  const sideways = patches.validateProposalShape(
    goodProposal({ expected: [{ signal: "glossaryTerms", direction: "improved", why: "more rows" }] })
  );
  assert.ok(sideways.problems.some((p) => p.kind === "bad-direction"), JSON.stringify(sideways.problems));
  const noWhy = patches.validateProposalShape(goodProposal({ expected: [{ signal: "glossaryTerms", direction: "up", why: "  " }] }));
  assert.ok(noWhy.problems.some((p) => p.kind === "expected-without-why"), JSON.stringify(noWhy.problems));

  // An unusable path is refused before it reaches the banned-path table.
  const unusable = patches.validateProposalShape(goodProposal({ files: ["../../outside.js"] }));
  assert.ok(unusable.problems.some((p) => p.kind === "unusable-path"), JSON.stringify(unusable.problems));

  // The good proposal lands, with no problems and no warnings.
  const good = patches.recordProposal(opened.patch.id, goodProposal(), patchPaths);
  assert.ok(!good.error, good.error);
  assert.deepStrictEqual(good.problems, []);
  assert.deepStrictEqual(good.warnings, []);
  assert.strictEqual(good.patch.status, "proposed");

  // A proposal is attached once, before the patch is judged. A second one would replace the
  // description the manager may already be reading.
  const twice = patches.recordProposal(opened.patch.id, goodProposal(), patchPaths);
  assert.match(twice.error, /already has a proposal/, twice.error);
  assert.match(twice.error, /refused attempts/i, twice.error);
}

async function scenarioARefusedAttemptIsHistoryNotTheCurrentState() {
  const { patchPaths, opened } = await openChannel("attempts");
  assert.ok(!opened.error, opened.error);

  const bad = patches.recordProposal(opened.patch.id, { files: ["glossary.js"], summary: "fixed it", actualChanges: [] }, patchPaths);
  assert.ok(bad.problems.length, "expected a refusal");

  const good = patches.recordProposal(opened.patch.id, goodProposal(), patchPaths);
  assert.ok(!good.error, good.error);

  const stored = patches.findPatch(opened.patch.id, patches.readPatches(patchPaths.json).patches);
  assert.deepStrictEqual(stored.problems, [], "a passing attempt must not leave the old problems as the current state");
  assert.strictEqual(stored.refusedAttempts.length, 1, JSON.stringify(stored.refusedAttempts));
  assert.ok(stored.refusedAttempts[0].problems.some((p) => p.kind === "missing-field"));

  const md = fsSync.readFileSync(patchPaths.markdown, "utf8");
  assert.ok(/Attempts the machine refused before this one/.test(md), md);
  assert.ok(!/Why this proposal was refused/.test(md), "the report must not say this proposal was refused when it was not");
}

// ─── 5. The judgment ──────────────────────────────────────────────────────────

async function scenarioAcceptingNeedsGreenChecksAndARealReason() {
  const { patchPaths, opened } = await openChannel("judgment");
  assert.ok(!opened.error, opened.error);
  const id = opened.patch.id;

  const nothingToJudge = patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  assert.strictEqual(nothingToJudge.patch, null);
  assert.match(nothingToJudge.error, /no proposal attached/, nothingToJudge.error);

  patches.recordProposal(id, goodProposal(), patchPaths);

  const tooSoon = patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  assert.strictEqual(tooSoon.patch, null);
  assert.match(tooSoon.error, /checks are not green/, tooSoon.error);
  assert.match(tooSoon.error, /not run: npm-test, pipeline-loop/, tooSoon.error);

  const failed = patches.recordChecks(id, [{ id: "npm-test", exitCode: 1, tail: "assertion failed" }], patchPaths);
  assert.strictEqual(failed.patch.status, "proposed", "a failed check does not move the patch forward");
  assert.strictEqual(failed.patch.checkVerdict.accepted, false);
  assert.ok(failed.patch.checkVerdict.failed.some((f) => f.includes("npm-test exited 1")), JSON.stringify(failed.patch.checkVerdict));

  const green = patches.recordChecks(id, GREEN_CHECKS(), patchPaths);
  assert.ok(!green.error, green.error);
  assert.strictEqual(green.patch.status, "verified");

  // The reason is the half the account owner reads afterwards, and the outcome-shaped ones are the
  // same demand `validateTicketShape` refuses on the manager's question (gotcha 70).
  for (const reason of [
    "volume 15 passes now",
    "the finding disappears",
    "make volume 15 pass",
    "the step is fixed",
    "it works",
    "no more quarantines",
  ]) {
    const refused = patches.acceptPatch(id, { reason }, patchPaths);
    assert.strictEqual(refused.patch, null, `"${reason}" was accepted`);
    assert.match(refused.error, /states only that the finding is gone/, `"${reason}": ${refused.error}`);
  }
  const noReason = patches.acceptPatch(id, { reason: "   " }, patchPaths);
  assert.match(noReason.error, /must carry the reason/, noReason.error);

  // A legitimate reason, including one that names the outcome AND names a quantity of the deliverable.
  const accepted = patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  assert.ok(!accepted.error, accepted.error);
  assert.strictEqual(accepted.patch.status, "accepted");
  assert.strictEqual(accepted.patch.decision.decidedBy, "manager");

  const twice = patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  assert.match(twice.error, /already accepted/, twice.error);

  // Rejecting does not need the checks to have run: refusing a proposal is free, and making the team
  // pay for a gate before being refused would be a way of never being refused.
  const other = await openChannel("judgment-reject");
  patches.recordProposal(other.opened.patch.id, goodProposal(), other.patchPaths);
  const rejected = patches.rejectPatch(other.opened.patch.id, { reason: "the summary does not say which row carries the fix" }, other.patchPaths);
  assert.ok(!rejected.error, rejected.error);
  assert.strictEqual(rejected.patch.status, "rejected");
  assert.strictEqual(patches.pendingPatches(other.patchPaths).length, 0, JSON.stringify(patches.readPatches(other.patchPaths.json).patches.map((p) => p.status)));
}

async function scenarioAnUnjudgedPatchIsLiveCode() {
  const { patchPaths, opened, ticket } = await openChannel("pending");
  assert.ok(!opened.error, opened.error);
  const id = opened.patch.id;
  patches.recordProposal(id, goodProposal(), patchPaths);

  // `proposed` and `verified` are both "sitting in the working tree with nobody having said whether it
  // stays". The working tree of `main` is what `npm run pipeline` executes (gotcha 66), so this is the
  // list act mode has to refuse while it is non-empty.
  assert.deepStrictEqual(patches.pendingPatches(patchPaths).map((p) => p.id), [id]);
  patches.recordChecks(id, GREEN_CHECKS(), patchPaths);
  assert.deepStrictEqual(patches.pendingPatches(patchPaths).map((p) => p.status), ["verified"]);

  patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  assert.deepStrictEqual(patches.pendingPatches(patchPaths), [], "an accepted patch is judged, so it is no longer pending");

  assert.strictEqual(patches.patchForTicket(ticket.id, patchPaths).id, id);
}

// ─── 6. The commit and the revert (real git) ──────────────────────────────────

async function scenarioCommitStagesExactlyWhatItDeclares() {
  const repo = await gitFixture("commit-repo");
  const before = git(["rev-parse", "HEAD"], repo).trim();

  // The patch's own change, plus an edit it never declared.
  await fs.writeFile(path.join(repo, "glossary.js"), 'export const gate = "spelling-resolution";\n', "utf8");
  await fs.writeFile(path.join(repo, "utils/prompt.js"), "export const truncate = \"I was never declared\";\n", "utf8");

  const { opened, patchPaths } = await openChannel("commit-channel");
  assert.ok(!opened.error, opened.error);
  const id = opened.patch.id;

  patches.recordProposal(
    id,
    goodProposal({ files: ["glossary.js"], actualChanges: ["glossary.js"], expected: [{ signal: "glossaryTerms", direction: "up", why: "volume 15's rows are counted" }] }),
    patchPaths
  );
  patches.recordChecks(id, GREEN_CHECKS(), patchPaths);

  // Not accepted yet: the commit is the acceptance act.
  const early = patches.commitPatch(id, { root: repo, paths: patchPaths });
  assert.strictEqual(early.commit, null);
  assert.match(early.error, /is verified/, early.error);

  patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);

  // The undeclared edit is refused, and nothing is committed.
  const refused = patches.commitPatch(id, { root: repo, paths: patchPaths });
  assert.strictEqual(refused.commit, null);
  assert.deepStrictEqual(refused.extra, ["utils/prompt.js"], JSON.stringify(refused.extra));
  assert.match(refused.error, /does not name/, refused.error);
  assert.strictEqual(git(["rev-parse", "HEAD"], repo).trim(), before, "a refused commit must not move HEAD");
  assert.match(fsSync.readFileSync(path.join(repo, "glossary.js"), "utf8"), /spelling-resolution/, "a refused commit must not stage anything either");

  // Put the undeclared edit back, and the commit stages exactly the declared file.
  git(["checkout", "--", "utils/prompt.js"], repo);
  const committed = patches.commitPatch(id, { root: repo, paths: patchPaths });
  assert.ok(!committed.error, committed.error);
  assert.ok(committed.commit.hash.length >= 7, JSON.stringify(committed.commit));
  assert.deepStrictEqual(committed.commit.files, ["glossary.js"]);

  const touched = git(["show", "--name-only", "--format=", "HEAD"], repo).trim().split("\n").filter(Boolean);
  assert.deepStrictEqual(touched, ["glossary.js"], JSON.stringify(touched));
  const message = git(["log", "-1", "--format=%B"], repo);
  assert.match(message, /Ticket /, message);
  assert.match(message, /fix\(glossary\)/, message);
  assert.match(message, /Accepted by manager/, message);

  const stored = patches.findPatch(id, patches.readPatches(patchPaths.json).patches);
  assert.strictEqual(stored.status, "committed");
  const judged = patches.rejectPatch(id, { reason: "changed my mind" }, patchPaths);
  assert.match(judged.error, /not undone by a judgment/, judged.error);
}

async function scenarioARejectedPatchIsReverted() {
  const repo = await gitFixture("revert-repo");
  const { opened, patchPaths } = await openChannel("revert-channel");
  assert.ok(!opened.error, opened.error);
  const id = opened.patch.id;

  await fs.writeFile(path.join(repo, "glossary.js"), 'export const gate = "wrong fix";\n', "utf8");
  await fs.writeFile(path.join(repo, "new-helper.js"), "export const helper = 1;\n", "utf8");

  patches.recordProposal(
    id,
    goodProposal({ files: ["glossary.js", "new-helper.js"], actualChanges: ["glossary.js", "new-helper.js"] }),
    patchPaths
  );
  patches.recordChecks(id, GREEN_CHECKS(), patchPaths);

  const tooEarly = patches.revertPatch(id, { root: repo, paths: patchPaths });
  assert.match(tooEarly.error, /Only a rejected patch is reverted/, tooEarly.error);

  patches.rejectPatch(id, { reason: "the rename test now accepts a row that only mentions the deleted spelling in passing" }, patchPaths);

  const reverted = patches.revertPatch(id, { root: repo, paths: patchPaths });
  assert.ok(!reverted.error, reverted.error);
  assert.deepStrictEqual(reverted.restored, ["glossary.js"], JSON.stringify(reverted));
  // A file the patch CREATED is left in place and named: deleting a file is Tier C, and this channel
  // does not get to decide that.
  assert.deepStrictEqual(reverted.leftBehind, ["new-helper.js"], JSON.stringify(reverted));
  assert.match(fsSync.readFileSync(path.join(repo, "glossary.js"), "utf8"), /exact-string/, "the tracked file is back to the committed state");
  assert.ok(fsSync.existsSync(path.join(repo, "new-helper.js")), "a created file is left for the account owner, not deleted");

  const md = fsSync.readFileSync(patchPaths.markdown, "utf8");
  assert.ok(/Still in the tree, created by this patch, for the account owner to remove/.test(md), md);
  assert.ok(/new-helper\.js/.test(md), md);
}

// ─── 7. Reading the tree, scoped ──────────────────────────────────────────────

async function scenarioTheWorkingTreeIsReadScopedToTheProject() {
  const repo = await gitFixture("scope-repo");
  await fs.mkdir(path.join(repo, "inner"), { recursive: true });
  await fs.mkdir(path.join(repo, "outer"), { recursive: true });
  await fs.writeFile(path.join(repo, "inner", "glossary.js"), "committed inside\n", "utf8");
  git(["add", "--", "."], repo);
  git(["commit", "-q", "-m", "folders"], repo);
  await fs.writeFile(path.join(repo, "inner", "glossary.js"), "changed inside\n", "utf8");
  // Untracked on purpose: `revertPatch` has to tell a file the patch CREATED apart from a file it
  // edited, and git's `??` is the only thing that says which.
  await fs.writeFile(path.join(repo, "outer", "notes.md"), "the account owner's in-progress translation output\n", "utf8");

  const scoped = patches.workingTreeChanges(path.join(repo, "inner"));
  assert.ok(!scoped.error, scoped.error);
  assert.deepStrictEqual(scoped.files.map((f) => f.path), ["inner/glossary.js"], JSON.stringify(scoped.files));

  const whole = patches.workingTreeChanges(repo);
  assert.ok(!whole.error, whole.error);
  assert.deepStrictEqual(whole.files.map((f) => f.path).sort(), ["inner/glossary.js", "outer/notes.md"], JSON.stringify(whole.files));

  // The untracked marker survives, because `revertPatch` needs to know which file the patch CREATED.
  const statuses = new Map(whole.files.map((f) => [f.path, f.status]));
  assert.strictEqual(statuses.get("outer/notes.md"), "??", JSON.stringify(whole.files));

  // And on the real repository: every path it reports resolves inside `ai-client/`. This repository's
  // tree is deliberately dirty OUTSIDE ai-client/ — the account owner's translation output — and a
  // patch channel that looked at the whole tree would either refuse everything or sweep the corpus
  // into a commit. `git add -A` is never used here for that reason.
  const real = patches.workingTreeChanges(patches.ROOT);
  assert.ok(!real.error, real.error);
  for (const f of real.files) {
    const abs = path.resolve(patches.ROOT, f.path);
    assert.ok(abs === patches.ROOT || abs.startsWith(patches.ROOT + path.sep), `${f.path} resolves outside ai-client/`);
  }
}

async function scenarioGitIsAskedNotGuessed() {
  // `ai-client/` is a subdirectory of this repository, so "the git root" is not
  // `path.resolve(root, "..")` in general. It is whatever git says — which is also what makes the same
  // code work against a throwaway fixture repository.
  const real = patches.gitRootOf(patches.ROOT);
  assert.ok(!real.error, real.error);
  assert.ok(patches.ROOT === real.root || patches.ROOT.startsWith(real.root + path.sep), `${real.root} is not an ancestor of ${patches.ROOT}`);

  const repo = await gitFixture("gitroot-repo");
  const nested = patches.gitRootOf(path.join(repo, "utils"));
  assert.ok(!nested.error, nested.error);
  assert.strictEqual(nested.root, repo, "it walked up to where git says the repository is");

  const missing = patches.gitRootOf(path.join(TMP, "no-such-directory"));
  assert.ok(missing.error, "expected an error");
  assert.match(missing.error, /git cannot be read/, missing.error);
}

// ─── 8. The report a human reads ──────────────────────────────────────────────

async function scenarioTheReportRendersWhatTheManagerCanCheck() {
  const { patchPaths, opened } = await openChannel("report");
  assert.ok(!opened.error, opened.error);
  const id = opened.patch.id;

  patches.recordProposal(id, goodProposal({ questions: ["Does volume 15 hold a glossary.md beside the quarantined file?"], ownerNote: "The guard reported a real change correctly." }), patchPaths);

  // The crash this suite exists for: a caller-supplied check with no `args` used to make the renderer
  // throw `Cannot read properties of undefined (reading 'join')` — in the writer, after the record was
  // already built. The command is taken from the pinned table, so there is nothing to join.
  const halfRun = patches.recordChecks(id, [{ id: "npm-test", exitCode: 0 }], patchPaths);
  assert.ok(!halfRun.error, halfRun.error);
  const md = fsSync.readFileSync(patchPaths.markdown, "utf8");
  assert.ok(/`npm test` → passed/.test(md), md);
  assert.ok(/never ran/.test(md), md);
  assert.ok(!/undefined/.test(md), md);

  // Everything the manager needs to decide, and nothing it is not allowed to see: no diff, no code.
  assert.ok(/What changed:/.test(md), md);
  assert.ok(/The mechanism it fixes:/.test(md), md);
  assert.ok(/What it could break:/.test(md), md);
  assert.ok(/What it expects to move in the deliverable:/.test(md), md);
  assert.ok(/`glossaryTerms` up/.test(md), md);
  assert.ok(/How the manager checks it:/.test(md), md);
  assert.ok(/Questions back to the manager/.test(md), md);
  assert.ok(/For the account owner only/.test(md), md);
  // The turn is reported as what it did, not as a limit it does not have: an uncapped
  // dev turn shows its tool calls, how many chunks it needed, what was set aside on
  // disk, and the harness's own word for how it ended.
  assert.ok(
    /Dev turn: 14 tool call\(s\) over 2 chunk\(s\), no step cap, 1 read answer\(s\) set aside on disk \(9100 tokens\), ended: complete/.test(md),
    md
  );
  assert.ok(!/step cap \d+/.test(md), "the report names no step cap for a role that has none");
  assert.ok(!/^[-+]{3} /m.test(md), "the manager reads a proposal, not a diff");

  // The header names what is waiting, because the tree is what the next run executes.
  assert.ok(/1 unjudged change\(s\) in the working tree of `main`/.test(md), md);
  assert.ok(/act mode refuses to run a step while one is waiting/.test(md), md);

  patches.recordChecks(id, GREEN_CHECKS(), patchPaths);
  patches.acceptPatch(id, { reason: GOOD_ACCEPT_REASON }, patchPaths);
  const final = fsSync.readFileSync(patchPaths.markdown, "utf8");
  assert.ok(/\*\*Decision:\*\* accepted by manager/.test(final), final);
  assert.ok(/Status: accepted/.test(final), final);
  assert.ok(/Nothing unjudged is in the working tree/.test(final), final);

  // An empty channel says so, in words a manager can act on.
  const empty = await patchDirFor("report-empty");
  patches.writePatches([], empty);
  const emptyMd = fsSync.readFileSync(empty.markdown, "utf8");
  assert.ok(/No patches\. Nothing has been proposed/.test(emptyMd), emptyMd);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ["the banned diff names the rule it hit", scenarioBannedPathsNameTheirRule],
  ["project source is a whitelist, not a blacklist", scenarioProjectSourceIsAWhitelist],
  ["the answer key is flagged, not banned", scenarioAnswerKeyIsFlaggedNotBanned],
  ["the npm test chain cannot be shortened", scenarioTestChainCannotBeShortened],
  ["the checks are pinned on the way in and on the way out", scenarioChecksArePinnedOnTheWayIn],
  ["a patch answers a chosen option, and nothing else", scenarioAPatchAnswersAChosenOption],
  ["one team at a time", scenarioOneTeamAtATime],
  ["a proposal is checked before it is attached", scenarioAProposalIsCheckedBeforeItIsAttached],
  ["a refused attempt is history, not the current state", scenarioARefusedAttemptIsHistoryNotTheCurrentState],
  ["accepting needs green checks and a reason about the deliverable", scenarioAcceptingNeedsGreenChecksAndARealReason],
  ["an unjudged patch is live code", scenarioAnUnjudgedPatchIsLiveCode],
  ["the commit stages exactly what the patch declared", scenarioCommitStagesExactlyWhatItDeclares],
  ["a rejected patch is reverted, and a created file is left behind", scenarioARejectedPatchIsReverted],
  ["the working tree is read scoped to the project", scenarioTheWorkingTreeIsReadScopedToTheProject],
  ["git is asked, not guessed", scenarioGitIsAskedNotGuessed],
  ["the report renders what the manager can check", scenarioTheReportRendersWhatTheManagerCanCheck],
];

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  // The `runChecks` scenario runs the PINNED `npm test` in this folder on purpose (to prove the runner
  // cannot be pointed at a softer command). A package.json with no `test` script makes that fail fast
  // and locally — and, crucially, stops npm from walking up the tree and running THIS suite inside
  // itself.
  await fs.writeFile(
    path.join(TMP, "package.json"),
    JSON.stringify({ name: "oresuki-patches-test-fixture", version: "1.0.0", private: true }, null, 2) + "\n",
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
    console.error(`\nFAILED: the patch channel does not hold.`);
    return;
  }
  console.log(`\nOK: ${scenarios.length} checks on the patch channel — the banned diff, the pinned checks, the door, the proposal, the judgment, the commit.`);
}

main();
