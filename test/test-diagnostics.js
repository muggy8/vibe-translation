/**
 * test/test-diagnostics.js — the diagnostics team: what it may read, what it may NOT do, and what
 * its answer has to look like.
 *
 * `npm run delivery` gives a manager authority over a run while it never sees the code (AGENTS.md
 * §3.6). When re-running stops working it opens a ticket. `node diagnose.js` is the other side of
 * that ticket: the support team that CAN read the code, the prompts and the run transcripts, and
 * that answers with a cause, options with their costs, a recommendation, and questions back.
 *
 * Four things are pinned here, and each one is a rule that would otherwise live only in a prompt:
 *
 *   1. **Read-only, enforced twice.** The agent is handed exactly three read tools (plus the two
 *      memory tools the harness adds), and its approve gate refuses every mutating call anyway — and
 *      RECORDS each refusal. This is gotcha 8's two-layer pattern applied to writes: advertising a
 *      tool the sandbox will not honour wastes part of the turn on the model discovering it, and a
 *      refusal nobody records is a support team that quietly tried to repair the data it was asked
 *      to explain.
 *   2. **The reply has a shape, and the shape check is fail-closed** (gotcha 7, same as the
 *      acceptance replies). A cause-less, option-less answer is not a thin diagnosis, it is a failed
 *      check.
 *   3. **The deliberate split from gotcha 70/73 stays split.** An option whose only stated check is
 *      "the finding disappears" is FLAGGED here and refused by the before/after comparison of the
 *      deliverable — not hidden by this module. A banned option is refused here, by name, with the
 *      escalation to the account owner.
 *   4. **A diagnosis shows its reading.** The turn's real tool calls are recorded next to the files
 *      the reply CLAIMS it read, and a citation the turn never opened is reported. The ticket's
 *      evidence is hashed before and after the turn, because "read-only" is a claim about a role
 *      that can only be checked against the disk.
 *
 * No live endpoint: the real harness, the real agent loop and the real file tools run against the
 * scripted server in `test/fake-backend.js` (gotcha 62), so the approve gate and the tool schemas
 * are the production ones. Every fixture is a throwaway series with its own `POSTMORTEM_DIR`, so
 * nothing here can read or write the live 17 volumes (gotcha 69).
 */
require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

// Both tickets and the ledger resolve their home through postMortemDir(), which reads POSTMORTEM_DIR
// at call time — pointing it at a temp folder keeps the real .postmortem/ (and the real series'
// history) out of the picture. See gotcha 69/71.
const TMP = path.join(os.tmpdir(), "oresuki-diagnostics-test");
process.env.POSTMORTEM_DIR = path.join(TMP, "postmortem");
// The diagnostics role fires `pre-manager` / `post-manager` around its model turn (docs/architecture.md: the
// guarantee belongs to the role that makes the call). Hooks are per-machine and optional, so a suite
// that does not pin the hooks directory would let THIS machine's `hooks/pre-manager.sh` load a real
// model during `npm test` (gotcha 22). Pinning it to an empty folder makes the hooks the documented
// no-op: absent files, nothing runs.
process.env.AI_CLIENT_HOOKS_DIR = path.join(TMP, "hooks");
// A suite that pins the context window must pin the output cap with it (gotcha 69): an empty string
// blocks `.env` (dotenv will not overwrite a variable that already exists) while parseInt("") → NaN
// keeps the cap derived from the window this suite means to test.
process.env.AI_CONTEXT_WINDOW = "32000";
process.env.AI_MAX_TOKENS = "";
process.env.RESEARCH_ENABLED = "false";

const harness = require("../harness");
const diagnostics = require("../utils/diagnostics");
const tickets = require("../utils/tickets");
const agents = require("../utils/agents");
const { startFakeBackend } = require("./fake-backend");

const SERIES = "Owaresuki";

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * A throwaway series plus the two things only the diagnostics role is allowed to read: a `.js` and a
 * run transcript. The bug it contains is the real one from gotcha 68 — `truncateGlossary` matching
 * the WHOLE term cell against the text, so an alias row can never be relevant and is systematically
 * dropped from the window.
 */
async function fixtureRoot(label) {
  const root = path.join(TMP, label);
  await fs.rm(root, { recursive: true, force: true });
  const seriesDir = path.join(root, "series");
  const v14 = path.join(seriesDir, `${SERIES}(14)`);
  const v15 = path.join(seriesDir, `${SERIES}(15)`);
  await fs.mkdir(v14, { recursive: true });
  await fs.mkdir(v15, { recursive: true });
  await fs.mkdir(path.join(root, ".logs", "run-1", "agent-glossary-amend"), { recursive: true });
  await fs.mkdir(path.join(root, "system-prompts"), { recursive: true });
  await fs.mkdir(path.join(root, "user-prompts"), { recursive: true });

  const glossary = (rows) =>
    [
      "# Glossary",
      "",
      "## Characters",
      "",
      "| Term | Rendering | Notes |",
      "|---|---|---|",
      ...rows,
    ].join("\n") + "\n";

  await fs.writeFile(
    path.join(v14, "glossary.md"),
    glossary([
      "| 双ふた花ばの恋こい物もの語がたり | Twin Flower Romance | the framed story |",
      "| 三つ編み魔王 / 三つ編み悪魔 | Braided Demon King | alias row |",
      "| 鈍感系巻き込まれ型主人公 | Oblivious Protagonist | persona tag |",
    ]),
    "utf8"
  );
  await fs.writeFile(
    path.join(v15, "glossary.md.rejected"),
    glossary([
      "| 双ふた花ばの恋物語 | Twin Flower Romance | also written 双ふた花ばの恋こい物もの語がたり |",
      "| 三つ編み魔王 / 三つ編み悪魔 / 魔王 | Braided Demon King | widened by the amend pass |",
      "| 鈍感系巻き込まれ型主人公 | Oblivious Protagonist | persona tag |",
    ]),
    "utf8"
  );

  // The code the manager may never open, and the exact line that caused the incident.
  await fs.writeFile(
    path.join(root, "glossary.js"),
    [
      "// fixture stand-in for the real glossary.js (gotcha 68)",
      "function truncateGlossary(glossary, sourceText) {",
      "  const src = String(sourceText || \"\");",
      "  return glossary.rows.filter((row) => {",
      "    const cells = row.split(\"|\");",
      "    return src.includes(cells[0]); // whole term cell: an alias row (A / B / C) never matches",
      "  });",
      "}",
      "module.exports = { truncateGlossary };",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "system-prompts", "glossary.md"),
    [
      "# Glossary amend",
      "",
      "If a new term conflicts with an existing one (e.g., the same character appears under two",
      "spellings), reconcile them to a single canonical form and note the change.",
      "",
    ].join("\n"),
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "user-prompts", "glossary.md"),
    ["# Amend the glossary", "", "Carry every existing term forward. New terms: {{NEW_TERMS}}", ""].join("\n"),
    "utf8"
  );

  await fs.writeFile(
    path.join(root, ".logs", "run-1", "agent-glossary-amend", "turn-001.md"),
    [
      "# agent-glossary-amend turn 001",
      "",
      "assistant: the extraction proposed 双ふた花ばの恋物語 as a new term. It conflicts with the",
      "existing row, so I reconcile them to one canonical form and move the old spelling into Notes.",
      "",
      "tool editFile → applied",
      "",
    ].join("\n"),
    "utf8"
  );

  return { root, seriesDir, v14, v15 };
}

/** The ticket the manager should have written about this fixture (findings-shaped, gotcha 70). */
function fixtureTicket(extra = {}) {
  return {
    step: "glossary",
    volume: "15",
    finding: "quarantine-present",
    evidence: [
      { file: `${SERIES}(15)/glossary.md.rejected`, note: "the quarantined file holds the reconciled row; no term column names the old spelling" },
      { file: `${SERIES}(14)/glossary.md`, note: "the previous volume's baseline names the old spelling in its term column" },
    ],
    ruledOut: [
      "the file did not shrink — the row count went up, so this is not a reply cut off mid-write",
      "re-running the step produced the identical quarantine twice, so it is not a transient failure",
    ],
    question:
      "Why is volume 15's glossary quarantined when its row count grew? The report says a term was " +
      "dropped, and that term is in the file under a different source-language spelling.",
    ...extra,
  };
}

/** Every file under a folder, hashed — the proof a read-only turn really only read. */
/**
 * A byte-for-byte fingerprint of a fixture tree.
 *
 * `skipDirs` names folders that are EXPECTED to change. The ticket files are the diagnosis's own
 * output, so a check that "nothing on disk moved" which counts them would report the answer itself
 * as tampering — and the honest version of the check is "the corpus it was asked about is untouched".
 */
function treeHash(dir, skipDirs = []) {
  const skip = new Set(skipDirs);
  const walk = (d, acc) => {
    for (const entry of fsSync.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(abs)) walk(abs, acc);
        continue;
      }
      acc.push(`${abs}:${crypto.createHash("sha256").update(fsSync.readFileSync(abs)).digest("hex")}`);
    }
    return acc;
  };
  return walk(dir, []).join("\n");
}

async function freshTicketPaths(name) {
  const dir = path.join(TMP, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return { json: path.join(dir, "tickets.json"), markdown: path.join(dir, "tickets.md") };
}

// ─── 1. The tool set: senses, no hands ────────────────────────────────────────

async function scenarioOnlyReadToolsAreAdvertised() {
  const { root } = await fixtureRoot("tools");
  const raw = await harness.createGatedFsTools({ cwd: root, allowedDirs: [root] });
  // The harness hands an author agent five tools. If that ever changes, `dropped` below stops
  // meaning anything and this assertion is the thing that says so.
  assert.deepStrictEqual(
    Object.keys(raw.tools).sort(),
    ["editFile", "grep", "listFiles", "readFile", "writeFile"],
    "the harness's own tool set is the five AGENTS.md promises (gotcha 8)"
  );

  const gate = await diagnostics.readOnlyFsTools({ cwd: root, allowedDirs: [root] });
  assert.deepStrictEqual(
    Object.keys(gate.tools).sort(),
    ["grep", "listFiles", "readFile"],
    "the diagnostics agent is offered exactly the three read tools — no writeFile, no editFile"
  );
  assert.deepStrictEqual(gate.advertised.slice().sort(), ["grep", "listFiles", "readFile"]);
  assert.deepStrictEqual(gate.dropped.slice().sort(), ["editFile", "writeFile"]);
  assert.ok(!("writeFile" in gate.tools) && !("editFile" in gate.tools) && !("deleteFile" in gate.tools));

  // The tool note must promise the same three READ tools, for the same reason AGENTS.md gotcha 8
  // exists: a tool the sandbox will not honour is a step spent discovering that. The two memory
  // tools are named too, because the harness adds them to this role's set (utils/context.js) and a
  // note that does not mention them leaves the agent to guess what they are for. The answer button is
  // named third because it is the fourth thing in the set and the only one that carries the answer.
  assert.ok(
    /three senses, two memory tools and one answer button/.test(diagnostics.DIAGNOSIS_TOOLS_NOTE),
    "the note says how many tools there are, and separates the senses from the memory tools and the answer"
  );
  assert.ok(
    /no writeFile, no editFile, no deleteFile/.test(diagnostics.DIAGNOSIS_TOOLS_NOTE),
    "the note names what is missing rather than leaving the model to guess"
  );
  assert.ok(
    !diagnostics.DIAGNOSIS_TOOLS_NOTE.includes("writeFile(filePath)"),
    "the note does not describe a write tool as if the role had it"
  );

  // The answer arrives as a tool call, not as a block to scrape out of prose — and the note is the
  // only place the role learns that. A role told to write JSON and given a button does the old,
  // fragile thing; a role given the button and no JSON instruction does the new one.
  assert.ok(
    diagnostics.DIAGNOSIS_TOOLS_NOTE.includes(diagnostics.DIAGNOSIS_ANSWER_TOOL),
    "the note names the answer button by the name the tool set actually registers"
  );
  assert.ok(
    !/Answer with one fenced/.test(diagnostics.DIAGNOSIS_TOOLS_NOTE),
    "the note does not also ask for the prose shape — two instructions, one followed"
  );
  assert.ok(
    !/fenced ```json/.test(fsSync.readFileSync(path.join(__dirname, "..", "system-prompts", "diagnostics.md"), "utf8")),
    "the system prompt does not ask for a fenced JSON block either (the prompt and the tools note cannot give two shapes)"
  );

  // The button's own shape: the five things every option must say are enforced by the provider, so a
  // missing one is a tool error the role can answer again inside the same turn instead of a diagnosis
  // that reaches a ticket half-written.
  const answer = diagnostics.diagnosisAnswerTool();
  assert.strictEqual(answer.name, "submit_diagnosis");
  assert.strictEqual(answer.state.answer, null, "nothing is recorded until the role calls it");

  const missingVerify = answer.tool.inputSchema.safeParse({
    cause: "The gate compares the artifact with the copy before it.",
    options: [{ label: "Re-run the step", touches: ["volume 02/glossary.md"], cost: "cheap", risk: "Nothing." }],
  });
  assert.strictEqual(missingVerify.success, false, "an option with no `verify` is refused before this code ever sees it");
  assert.ok(
    missingVerify.error.issues.some((issue) => issue.path.join(".") === "options.0.verify"),
    `the refusal names the missing field: ${JSON.stringify(missingVerify.error.issues.map((i) => i.path.join(".")))}`
  );
  const inventedCost = answer.tool.inputSchema.safeParse({
    cause: "The gate compares the artifact with the copy before it.",
    options: [{ label: "Re-run the step", touches: ["volume 02/glossary.md"], cost: "moderate", risk: "Nothing.", verify: "The term count." }],
  });
  assert.strictEqual(inventedCost.success, false, "a cost word the channel does not use is refused (free / cheap / expensive)");
  const noOptions = answer.tool.inputSchema.safeParse({ cause: "The gate compares the artifact with the copy before it.", options: [] });
  assert.strictEqual(noOptions.success, false, "a diagnosis that offers nothing is refused at the call, not at the ticket");
  const noCause = answer.tool.inputSchema.safeParse({
    cause: "",
    options: [{ label: "Re-run the step", touches: ["volume 02/glossary.md"], cost: "cheap", risk: "Nothing.", verify: "The term count." }],
  });
  assert.strictEqual(noCause.success, false, "an empty cause is refused: the role's whole job is the explanation");
  const recorded = await answer.tool.execute(
    {
      cause: "The gate compares the artifact to the copy before it, and the copy was missing.",
      options: [
        {
          label: "Re-run the step with the previous volume's artifact in place",
          touches: ["volume 02/glossary.md"],
          cost: "cheap",
          risk: "Nothing: it re-does work that already ran.",
          verify: "The term count in the volume 02 report goes up.",
        },
      ],
      read: ["volume-02/glossary-validation.md"],
    },
    { toolCallId: "t1", messages: [] }
  );
  assert.match(recorded, /^RECORDED/, "the tool says plainly what happened to the answer");
  assert.ok(answer.state.answer, "the answer is recorded at the moment it is given");
  const second = await answer.tool.execute(
    { cause: "again", options: [{ label: "x", touches: ["y"], cost: "free", risk: "z", verify: "w" }] },
    { toolCallId: "t2", messages: [] }
  );
  assert.match(second, /^REFUSED/, "one answer per turn, enforced by the tool itself");
  assert.strictEqual(answer.state.repeats, 1);
  assert.strictEqual(answer.state.refusals.length, 1);
  assert.ok(
    answer.state.answer.options.length === 1 && answer.state.answer.cause.startsWith("The gate"),
    "the first answer is the one kept"
  );

  // The role is uncapped now, so the working window is the size limit it actually has — and the note
  // is the only place the agent learns what the line on every tool answer means. A role told it has
  // no step limit, and never told what DOES run out, is a role that discovers it at 262k tokens.
  const note = diagnostics.DIAGNOSIS_TOOLS_NOTE;
  assert.ok(note.includes("manage_context") && note.includes("recall_memory"), "both memory tools are named");
  assert.ok(/## Your working window/.test(note), "the note has a section about the working window");
  assert.ok(
    /\|\s*working window:\s*[\d,]+ \/ [\d,]+ tokens \(\d+%\)/.test(note),
    "the note shows the agent the exact shape of the line stamped on every tool answer"
  );
  assert.ok(/no step limit/.test(note), "the note says out loud that this turn has no step limit");
  assert.ok(
    /Setting a read aside is not forgetting it/.test(note),
    "the note tells the role that setting a read aside is not losing it — the whole point of the memory tools"
  );
  assert.ok(/re-read a file you have\s+already read/.test(note), "the note names the failure this role actually had: re-opening the same file");
}

// ─── 2. The gate refuses every mutating call, and records it ──────────────────

async function scenarioGateRefusesAndRecordsEveryWrite() {
  const { root } = await fixtureRoot("gate");
  const gate = await diagnostics.readOnlyFsTools({ cwd: root, allowedDirs: [root] });

  // The underlying gate WOULD have allowed these — the folder is in allowedDirs. So the refusal is
  // this role's gate doing the work, not the sandbox's accident.
  for (const toolName of ["writeFile", "editFile"]) {
    assert.strictEqual(
      gate.approve({ toolName, input: { filePath: "series/Owaresuki(15)/glossary.md", content: "x", oldString: "y", newString: "z" } }),
      false,
      `${toolName} must be refused even though the folder is writable`
    );
  }
  assert.strictEqual(
    gate.approve({ toolName: "deleteFile", input: { filePath: "series/Owaresuki(15)/glossary.md.rejected" } }),
    false,
    "deleteFile is refused too — Tier C, and the gate names it in case a library version injects it"
  );

  assert.strictEqual(gate.approve({ toolName: "readFile", input: { filePath: "glossary.js" } }), true, "reads are allowed");
  assert.strictEqual(gate.approve({ toolName: "grep", input: { pattern: "cells", dirPath: "." } }), true);

  assert.strictEqual(gate.refusals.length, 3, "every refusal is recorded, not swallowed");
  for (const r of gate.refusals) {
    assert.ok(r.tool && r.path && r.reason, `a refusal must name the tool, the path and the reason: ${JSON.stringify(r)}`);
    assert.ok(r.at, "and when it happened");
  }
  assert.deepStrictEqual(gate.refusals.map((r) => r.tool), ["writeFile", "editFile", "deleteFile"]);
  // The sentence names where the authority actually is, so the model cannot "try harder".
  assert.ok(/no write access/.test(diagnostics.READ_ONLY_REFUSAL));
  assert.ok(/dev team/.test(diagnostics.READ_ONLY_REFUSAL), "it names the role that may change a file");
  assert.ok(/account owner/.test(diagnostics.READ_ONLY_REFUSAL), "and the role that may un-check a guard");
}

// ─── 3. The read-only set can really reach the transcripts and the code ───────

async function scenarioReadOnlyToolsCanActuallyReadEverything() {
  const { root } = await fixtureRoot("reading");
  const gate = await diagnostics.readOnlyFsTools({ cwd: root, allowedDirs: [root] });

  const code = await gate.tools.readFile.execute({ filePath: "glossary.js" });
  assert.ok(!code.error, `readFile on the code errored: ${code.error}`);
  assert.ok(/cells\[0\]/.test(code.content), "it can open the code the manager may not see");

  const transcript = await gate.tools.readFile.execute({ filePath: ".logs/run-1/agent-glossary-amend/turn-001.md" });
  assert.ok(!transcript.error, `readFile on a transcript errored: ${transcript.error}`);
  assert.ok(/reconcile them to one canonical form/.test(transcript.content), "it can open a run transcript");

  const prompt = await gate.tools.readFile.execute({ filePath: "system-prompts/glossary.md" });
  assert.ok(!prompt.error, `readFile on a prompt errored: ${prompt.error}`);
  assert.ok(/reconcile them to a single canonical form/.test(prompt.content), "it can open the prompt that asked for the edit");

  // grep takes a FOLDER (gotcha 60) — the contract the note restates, proven against the tool.
  const hits = await gate.tools.grep.execute({ pattern: "reconcile", dirPath: "system-prompts" });
  assert.ok(!hits.error, `grep errored: ${hits.error}`);
  assert.strictEqual(hits.matchCount, 1, "grep searches the folder it is given");
  const listed = await gate.tools.listFiles.execute({ dirPath: "series" });
  assert.ok(!listed.error, `listFiles errored: ${listed.error}`);
  assert.ok(listed.entries.some((e) => e.name === `${SERIES}(15)`), "listFiles walks the series folders");
}

// ─── 4. The reply contract: what refuses, what warns ──────────────────────────

const GOOD_DIAGNOSIS = {
  cause:
    "The extraction pass is shown a truncated copy of the previous glossary, and the relevance test " +
    "compares the WHOLE term cell against the text. An alias row (A / B / C) is never a substring of " +
    "the chapter, so it is dropped from the window, re-proposed as new, and the amend pass reconciles " +
    "the two spellings into one row exactly as its prompt tells it to. The gate then looks only in " +
    "the term columns and calls the reconciled row a deletion.",
  options: [
    {
      label: "Compare each alias spelling, not the whole cell",
      touches: ["glossary.js truncateGlossary"],
      cost: "cheap",
      risk: "a row whose alias is a very short span becomes relevant more often, so the window fills with different rows",
      verify: "the row for the framed-story term appears in the excerpt the extraction pass is shown for volume 15",
      requiresCodeChange: true,
    },
    {
      label: "Add the old spelling back as a second row",
      touches: ["series/Owaresuki(15)/glossary.md"],
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
    {
      label: "Delete the quarantined file so the volume stops being reported",
      touches: ["series/Owaresuki(15)/glossary.md.rejected"],
      cost: "free",
      risk: "the evidence that would have explained the incident is gone",
      verify: "the report stops naming volume 15",
    },
  ],
  recommend: "Compare each alias spelling, not the whole cell — it is the only option that changes the deliverable.",
  questions: [
    "Does volume 15's folder hold a glossary.md beside the quarantined file, or only the quarantined file?",
  ],
  read: ["glossary.js", "system-prompts/glossary.md"],
  ownerNote:
    "If the account owner wants volume 15 rebuilt before the relevance fix lands, that is their call. " +
    "The guard is not the fault here — it reported a real change correctly.",
};

function cloneDiagnosis(extra = {}) {
  return JSON.parse(JSON.stringify({ ...GOOD_DIAGNOSIS, ...extra }));
}

async function scenarioReplyContract() {
  // A reply with no cause is not a thin diagnosis: it is a failed check.
  const noCause = diagnostics.validateDiagnosisShape(cloneDiagnosis({ cause: "" }));
  assert.strictEqual(noCause.ok, false);
  assert.ok(noCause.problems.some((p) => p.kind === "no-cause"), JSON.stringify(noCause.problems));

  const noOptions = diagnostics.validateDiagnosisShape(cloneDiagnosis({ options: [] }));
  assert.strictEqual(noOptions.ok, false);
  assert.ok(noOptions.problems.some((p) => p.kind === "no-options"));

  const halfAnOption = diagnostics.validateDiagnosisShape(
    cloneDiagnosis({ options: [{ label: "Something" }] })
  );
  assert.strictEqual(halfAnOption.ok, false);
  const problem = halfAnOption.problems.find((p) => p.kind === "option-incomplete");
  assert.ok(problem, JSON.stringify(halfAnOption.problems));
  assert.ok(/missing touches, cost, risk, verify/.test(problem.message), problem.message);
  assert.ok(/free \/ cheap \/ expensive/.test(problem.message), "a refusal names the words it accepts");

  // A cost word that is not one of the three is the same refusal: "moderate" is a word a guess invented.
  const inventedCost = diagnostics.validateDiagnosisShape(
    cloneDiagnosis({ options: [{ label: "Something", touches: ["a file"], cost: "moderate", risk: "r", verify: "v" }] })
  );
  assert.strictEqual(inventedCost.ok, false);
  assert.ok(
    /is missing cost/.test((inventedCost.problems.find((p) => p.kind === "option-incomplete") || {}).message || ""),
    JSON.stringify(inventedCost.problems)
  );

  // A question only a code reader can answer is refused at the generator, so the conversation does
  // not stall on something the manager cannot reply to.
  const asksForCode = diagnostics.validateDiagnosisShape(
    cloneDiagnosis({ questions: ["What does truncateGlossary do in glossary.js?"] })
  );
  assert.strictEqual(asksForCode.ok, false);
  assert.ok(asksForCode.problems.some((p) => p.kind === "unanswerable-question"), JSON.stringify(asksForCode.problems));

  const asksForTranscript = diagnostics.validateDiagnosisShape(
    cloneDiagnosis({ questions: ["Can you read the .logs/ transcript and tell me what it says?"] })
  );
  assert.strictEqual(asksForTranscript.ok, false, "the transcripts belong to the team, not to the customer");

  // The honest answer is a warning, not a refusal: thin cause, no cited reading, a recommendation
  // that names nothing offered.
  const thin = diagnostics.validateDiagnosisShape(
    cloneDiagnosis({ cause: "The guard fired.", read: [], recommend: "do the sensible thing" })
  );
  assert.strictEqual(thin.ok, true, "a weak answer is still an answer the manager can read");
  for (const kind of ["thin-cause", "no-reading-cited", "recommendation-names-nothing"]) {
    assert.ok(thin.warnings.some((w) => w.kind === kind), `expected a ${kind} warning: ${JSON.stringify(thin.warnings)}`);
  }

  // Parsing is fail-closed, like the acceptance replies (gotcha 7).
  assert.strictEqual(diagnostics.parseDiagnosisReply("").diagnosis, null);
  assert.strictEqual(diagnostics.parseDiagnosisReply("I looked into it and it seems fine.").diagnosis, null);
  const fenced = diagnostics.parseDiagnosisReply(
    "Reasoning first.\n\n```json\n{\"cause\":\"the mechanism is the relevance test comparing the whole term cell\"}\n```"
  );
  assert.ok(fenced.diagnosis, JSON.stringify(fenced.problems));
  // The LAST fenced block wins: a reply that quotes an example earlier must not be read as that example.
  const twoBlocks = diagnostics.parseDiagnosisReply(
    "Example shape:\n```json\n{\"cause\":\"example\"}\n```\nMy answer:\n```json\n{\"cause\":\"the real mechanism, stated at length so it clears the thin-cause warning\"}\n```"
  );
  assert.ok(twoBlocks.diagnosis.cause.startsWith("the real mechanism"), twoBlocks.diagnosis.cause);
}

// ─── 5. The deliberate split: flagged here, refused by the comparison ──────────

async function scenarioOutcomeOnlyVerificationIsFlaggedNotRefused() {
  const checked = diagnostics.validateDiagnosisShape(cloneDiagnosis());
  assert.strictEqual(checked.ok, true, JSON.stringify(checked.problems));

  const planted = checked.diagnosis.options.find((o) => o.label === "Add the old spelling back as a second row");
  assert.ok(planted, "the option the ticket filter deliberately does NOT ban must survive this one too");
  assert.strictEqual(planted.outcomeOnlyVerification, true);
  const warning = checked.warnings.find((w) => w.kind === "outcome-only-verification");
  assert.ok(warning, JSON.stringify(checked.warnings));
  assert.ok(/delivery-verify/.test(warning.message), "the warning names the check that will actually judge it");

  assert.strictEqual(diagnostics.verificationIsOutcomeOnly("the finding disappears"), true);
  assert.strictEqual(diagnostics.verificationIsOutcomeOnly("the volume no longer fails the gate"), true);
  assert.strictEqual(
    diagnostics.verificationIsOutcomeOnly("the term row for the framed story appears in the excerpt shown to the extraction pass"),
    false,
    "a check about the deliverable is not a check about the finding"
  );
}

// ─── 6. Banned options are refused by name, kept visible, and escalate ────────

async function scenarioBannedOptionsRefusedAndKept() {
  const paths = await freshTicketPaths("banned");
  const created = tickets.createTicket(fixtureTicket(), paths);
  assert.ok(created.written, JSON.stringify(created.problems));

  const written = tickets.recordDiagnosis(created.ticket.id, cloneDiagnosis(), paths);
  assert.ok(!written.error, written.error);

  const allowedLabels = written.allowed.map((o) => o.label);
  assert.deepStrictEqual(
    allowedLabels,
    ["Compare each alias spelling, not the whole cell", "Add the old spelling back as a second row"],
    "the two legitimate options are the only ones offered"
  );
  assert.strictEqual(written.refused.length, 2, JSON.stringify(written.refused.map((r) => r.option.label)));
  for (const r of written.refused) {
    assert.ok(r.because, "a refusal states why");
    assert.ok(/account owner/.test(r.escalateTo), `a refusal names who may do it: ${r.escalateTo}`);
    assert.ok(r.ids.length, "and which rule refused it");
  }
  assert.ok(written.refused.some((r) => r.ids.includes("disable-carry-forward-guard")));
  assert.ok(written.refused.some((r) => r.ids.includes("delete-evidence")));

  const ticket = tickets.readTickets(paths.json).tickets[0];
  assert.strictEqual(ticket.status, "answered");
  assert.strictEqual(ticket.noUsableOptions, false, "usable options survived, so the ticket is not flagged");
  assert.strictEqual(ticket.options.length, 2);
  assert.strictEqual(ticket.refusedOptions.length, 2, "refused options stay on the ticket — a dropped option looks like it was never thought of");

  const md = await fs.readFile(paths.markdown, "utf8");
  assert.ok(md.includes("~~Turn off the glossary carry-forward guard for volume 15~~"), md.slice(0, 600));
  assert.ok(md.includes("goes to: the account owner"), md.slice(0, 600));
  assert.ok(md.includes("its only stated check is that the finding disappears"), "the flag reaches the human file too");
  assert.ok(md.includes("For the account owner only"), "the ownerNote is rendered as prose, not as an option");
}

async function scenarioEveryOptionRefusedIsNotAnAnswer() {
  const paths = await freshTicketPaths("all-refused");
  const created = tickets.createTicket(fixtureTicket(), paths);
  const written = tickets.recordDiagnosis(
    created.ticket.id,
    cloneDiagnosis({
      options: [
        {
          label: "Turn off the glossary carry-forward guard",
          touches: ["GLOSSARY_CARRY_FORWARD_GUARD"],
          cost: "free",
          risk: "nothing checks the invariant",
          verify: "the volume is accepted",
        },
        {
          label: "Lower PASSING_SCORE so the volume's glossary is accepted",
          touches: ["PASSING_SCORE"],
          cost: "free",
          risk: "the definition of good enough moves",
          verify: "the volume is accepted",
        },
      ],
    }),
    paths
  );
  assert.strictEqual(written.allowed.length, 0);
  assert.strictEqual(written.refused.length, 2);

  const ticket = tickets.readTickets(paths.json).tickets[0];
  assert.strictEqual(ticket.noUsableOptions, true, "'answered' would be a lie the manager acts on");
  const md = await fs.readFile(paths.markdown, "utf8");
  assert.ok(md.includes("**No usable option.**"), md.slice(-900));
  assert.ok(md.includes("For the account owner only"), "the note is where the real belief lives");
}

// ─── 7. A diagnosis shows its reading ─────────────────────────────────────────

async function scenarioCrossChecksReads() {
  const observed = [
    { name: "readFile", input: { filePath: "glossary.js" }, error: null },
    { name: "grep", input: { pattern: "cells", dirPath: "system-prompts" }, error: null },
    { name: "readFile", input: { filePath: "utils/tickets.js" }, error: "ENOENT: no such file" },
    { name: "writeFile", input: { filePath: "series/Owaresuki(15)/glossary.md" }, error: "denied" },
  ];
  const result = diagnostics.crossCheckReads(
    ["glossary.js", "system-prompts/glossary.md", "utils/tickets.js", "./glossary.js/"],
    observed
  );
  assert.deepStrictEqual(
    result.observed,
    [
      { tool: "readFile", path: "glossary.js" },
      { tool: "grep", path: "system-prompts" },
      { tool: "readFile", path: "utils/tickets.js", errored: true },
    ],
    "only the read tools count as reading, and a mutating attempt never does"
  );
  assert.deepStrictEqual(
    result.unsupported,
    ["utils/tickets.js"],
    "a file whose only read attempt ERRORED is not evidence, and a citation nobody opened is reported"
  );
  assert.ok(
    !result.unsupported.includes("system-prompts/glossary.md"),
    "a grep over a FOLDER read everything in it — accusing that is a false positive (gotcha 60/65)"
  );
  assert.ok(result.unmentioned.includes("system-prompts"), "a read the reply forgot to mention is information, not a fault");
  assert.ok(!result.unsupported.includes("glossary.js"), "./glossary.js/ is the same file as glossary.js");

  const rooted = diagnostics.crossCheckReads(
    ["utils/tickets.js"],
    [{ name: "grep", input: { pattern: "x", dirPath: "." }, error: null }]
  );
  assert.deepStrictEqual(rooted.unsupported, [], "a search of the whole tree covers a file inside it");
}

// ─── 8. The manager's side of the conversation ────────────────────────────────

async function scenarioManagerAnswersAreCheckedOnTheAnswer() {
  const paths = await freshTicketPaths("answers");
  const created = tickets.createTicket(fixtureTicket(), paths);
  tickets.recordDiagnosis(created.ticket.id, cloneDiagnosis(), paths);

  const ticket = tickets.readTickets(paths.json).tickets[0];
  const asked = tickets.unansweredQuestions(ticket);
  assert.strictEqual(asked.length, 1, asked.join(" | "));

  // An answer that cites something a customer may not read is refused — the check is on the answer,
  // because the question was already screened at the generator.
  const citesTranscript = tickets.recordAnswer(
    created.ticket.id,
    { question: asked[0], answer: "the transcript says it reconciled them", cites: [".logs/run-1/agent-glossary-amend/turn-001.md"] },
    paths
  );
  assert.strictEqual(citesTranscript.written, false);
  assert.ok(/may not read/.test(citesTranscript.error), citesTranscript.error);

  for (const bad of ["glossary.js", "system-prompts/glossary.md", "hooks/pre-glossary.sh", "utils/tickets.js"]) {
    const refused = tickets.recordAnswer(created.ticket.id, { question: asked[0], answer: "x", cites: [bad] }, paths);
    assert.strictEqual(refused.written, false, `${bad} must not be citable by the manager`);
    assert.ok(refused.error.includes(bad), refused.error);
  }

  const good = tickets.recordAnswer(
    created.ticket.id,
    {
      question: asked[0],
      answer: "volume 15's folder holds glossary.md.rejected and no glossary.md",
      cites: ["Owaresuki(15)/glossary.md.rejected", ".postmortem/glossary.md"],
    },
    paths
  );
  assert.ok(good.written, good.error);
  const answered = tickets.readTickets(paths.json).tickets[0];
  assert.strictEqual(tickets.unansweredQuestions(answered).length, 0);
  assert.strictEqual(answered.answers.length, 1);

  const md = await fs.readFile(paths.markdown, "utf8");
  assert.ok(md.includes("The manager answered"), md.slice(0, 900));
  assert.ok(md.includes("glossary.md.rejected and no glossary.md"), md.slice(0, 900));

  // Answering a question the ticket never asked is refused, so an answer cannot be attached to the
  // wrong thing.
  const wrong = tickets.recordAnswer(
    created.ticket.id,
    { question: "Is the sky blue?", answer: "yes", cites: [] },
    paths
  );
  assert.strictEqual(wrong.written, false);
  assert.ok(/not a question this ticket asked/.test(wrong.error), wrong.error);

  const noQuestion = tickets.recordAnswer(created.ticket.id, { question: asked[0], answer: "already answered", cites: [] }, paths);
  assert.strictEqual(noQuestion.written, false, "every question is answered once");
  assert.ok(/no open question/.test(noQuestion.error), noQuestion.error);
}

// ─── 9. The turn has no step cap, and says what stands in its place ───────────

async function scenarioTheDiagnosisTurnHasNoStepCap() {
  // Gone, not hidden behind a bigger number. The old cap (3 steps per 32 KB page, ceiling 120) is
  // what produced the failure this role actually had: a 73-call, 7.2M-token diagnosis whose last 39
  // steps re-opened the same file because its transcript had outgrown the server, answering with
  // nothing. A cap decides how early that happens; it does not prevent it. CONTEXT-MANAGEMENT-DESIGN.md §7.1.
  const capNames = [
    "diagnosticsMaxStepsFor",
    "DIAGNOSIS_STEP_CAP_CEILING",
    "devteamMaxStepsFor",
    "DEVTEAM_STEP_CAP_CEILING",
    "STEP_CAP_PAGE_BYTES",
  ];
  for (const name of capNames) {
    assert.strictEqual(name in diagnostics, false, `the diagnostics team must not still carry ${name}`);
  }

  // No token budget either, and no knob for either one: a limit the role can switch off is not a
  // limit (gotcha 70), and a spending limit would hide the spin behind a cost error.
  assert.strictEqual(process.env.DIAGNOSIS_TOKEN_BUDGET, undefined);
  assert.strictEqual(process.env.DIAGNOSIS_MAX_STEPS, undefined);

  // What replaced them: the evidence size is PRINTED for the reader of the run log, and the role is
  // TOLD, in the note it reads before it reads anything, what does run out.
  const note = diagnostics.DIAGNOSIS_TOOLS_NOTE;
  assert.ok(/working window/.test(note), "the note names the window the turn can see filling up");
  assert.ok(/repeat/i.test(note), "the note names repeating itself as one of the walls");
  assert.ok(/manage_context/.test(note) && /recall_memory/.test(note), "the note names the two memory tools");

  // And the record that replaced "the cap it ran under". `endedAs` is the harness's own word, kept
  // verbatim: a record must not soften "stopped" into "finished".
  const shape = agents.turnShapeOf({
    chunks: 2,
    toolCalls: [{ name: "readFile" }, { name: "grep" }, { name: "readFile" }],
    offloads: [{ tokensBefore: 90000, tokensAfter: 40000 }],
    compactions: 0,
    result: "stopped",
  });
  assert.strictEqual(shape.chunks, 2);
  assert.strictEqual(shape.toolCalls, 3);
  assert.strictEqual(shape.offloads, 1);
  assert.strictEqual(shape.offloadedTokens, 50000);
  assert.strictEqual(shape.endedAs, "stopped", "the harness's own word, not a softer one");
}

// ─── 10. The whole turn, against the real harness and the real file tools ─────

async function scenarioRealTurnStaysReadOnly() {
  const { root, seriesDir } = await fixtureRoot("real-turn");
  const paths = {
    json: path.join(root, "postmortem", "tickets.json"),
    markdown: path.join(root, "postmortem", "tickets.md"),
  };
  await fs.mkdir(path.dirname(paths.json), { recursive: true });
  process.env.POSTMORTEM_DIR = path.dirname(paths.json);

  const created = tickets.createTicket(fixtureTicket(), paths);
  assert.ok(created.written, JSON.stringify(created.problems));

  // The ticket files are the diagnosis's own output, so they are the one thing in the tree that is
  // ALLOWED to change. Everything else — the code, the prompts, the transcripts, every volume folder
  // — must come back byte-for-byte.
  const skipDirs = [path.dirname(paths.json)];
  const before = treeHash(root, skipDirs);
  const glossaryCopy = await fs.readFile(path.join(root, "series", `${SERIES}(14)`, "glossary.md"), "utf8");

  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => {
      // Which step of the turn this is, counted on ASSISTANT messages: one per model step, whatever
      // shape the harness packages the tool answers in (a step that fires three calls at once may
      // come back as three tool messages or one). Counting tool messages instead would make the
      // second scripted step unreachable — the bug this scenario nearly shipped with.
      const step = req.messages.filter((m) => m.role === "assistant").length;
      if (step === 0) {
        return {
          text: "",
          toolCalls: [
            { name: "readFile", arguments: { filePath: "glossary.js" } },
            { name: "readFile", arguments: { filePath: `series/${SERIES}(15)/glossary.md.rejected` } },
            { name: "grep", arguments: { pattern: "reconcile", dirPath: "system-prompts" } },
          ],
        };
      }
      if (step === 1) {
        // The support team tries to repair the data while it is being asked to explain it.
        return {
          text: "",
          toolCalls: [
            { name: "writeFile", arguments: { filePath: `series/${SERIES}(15)/glossary.md`, content: "# patched by the support team\n" } },
            { name: "editFile", arguments: { filePath: "glossary.js", oldString: "cells[0]", newString: "spans" } },
          ],
        };
      }
      return {
        text:
          "I read the amend code, the quarantined file and the prompt that asked for the reconciliation.\n\n" +
          "```json\n" +
          JSON.stringify({
            ...cloneDiagnosis(),
            read: [
              "glossary.js",
              `series/${SERIES}(15)/glossary.md.rejected`,
              "system-prompts/glossary.md",
              "user-prompts/glossary.md",
            ],
          }) +
          "\n```\n",
      };
    },
  });
  backend.pointEnvAt();

  try {
    const result = await diagnostics.diagnoseTicket({
      ticketId: created.ticket.id,
      seriesDir,
      root,
      paths,
    });

    assert.ok(result.ok, `${result.error}\n${result.problems.map((p) => p.message).join("\n")}`);

    // The advertised tool set on the wire: the three read tools, the two memory tools the harness adds
    // to a managed role, and the one answer button. The prompt audit's rule that a tool the sandbox
    // would always refuse must not be advertised (AGENTS.md gotcha 8) — asserted at the request, where
    // the model actually sees it. `writeFile` / `editFile` / `deleteFile` are absent because
    // `readOnlyFsTools` never hands them over, not because the gate is expected to catch them. The
    // answer button is the fourth entry and the only one that carries the diagnosis; it writes nothing
    // to disk, which the byte-identical tree below is what actually proves.
    const advertised = (backend.requests[0].tools || []).map((t) => t.name ?? t.function?.name).filter(Boolean).sort();
    assert.deepStrictEqual(
      advertised,
      ["grep", "listFiles", "manage_context", "readFile", "recall_memory", "submit_diagnosis"],
      JSON.stringify(advertised)
    );
    assert.ok(backend.requests.length >= 3, "the turn really ran: reads, the refused write, then the answer");

    // Nothing on disk moved. Not the artifact, not the code, not the transcript.
    assert.strictEqual(treeHash(root, skipDirs), before, "a read-only role that wrote something would show up here");
    const afterCopy = await fs.readFile(path.join(root, "series", `${SERIES}(14)`, "glossary.md"), "utf8");
    assert.strictEqual(afterCopy, glossaryCopy);
    assert.strictEqual(
      fsSync.existsSync(path.join(root, "series", `${SERIES}(15)`, "glossary.md")),
      false,
      "the file it tried to create does not exist"
    );

    // Both refusals are recorded, and they reach the ticket and the human-readable file.
    assert.deepStrictEqual(result.writeAttempts.map((w) => w.tool), ["writeFile", "editFile"]);
    assert.ok(result.writeAttempts[0].path.includes(`${SERIES}(15)/glossary.md`), JSON.stringify(result.writeAttempts[0]));
    const ticket = result.ticket;
    assert.deepStrictEqual(ticket.diagnosis.attemptedWrites.map((w) => w.tool), ["writeFile", "editFile"]);
    const md = await fs.readFile(paths.markdown, "utf8");
    assert.ok(md.includes("Write attempts the read-only role refused"), md.slice(0, 1200));
    assert.ok(md.includes("`editFile` on `glossary.js`"), md.slice(0, 1200));
    assert.ok(md.includes("stopped by the tool set"), md.slice(0, 1200));

    // The reading cross-check: four claims, three the turn really made. The grep over the
    // `system-prompts` FOLDER covers the file inside it; the user prompt was never touched at all.
    assert.deepStrictEqual(ticket.diagnosis.citedWithoutReading, ["user-prompts/glossary.md"]);
    assert.ok(result.warnings.some((w) => w.kind === "cited-without-reading"), JSON.stringify(result.warnings));
    const observed = ticket.diagnosis.observedReads.map((r) => r.path);
    assert.ok(observed.includes("glossary.js"), JSON.stringify(observed));
    assert.ok(observed.includes(`series/${SERIES}(15)/glossary.md.rejected`), JSON.stringify(observed));
    assert.ok(observed.includes("system-prompts"), JSON.stringify(observed));
    assert.ok(!observed.includes("glossary.js.patched"));

    // The filter ran on the way in, and the split stayed split.
    assert.deepStrictEqual(
      ticket.options.map((o) => o.label),
      ["Compare each alias spelling, not the whole cell", "Add the old spelling back as a second row"]
    );
    assert.strictEqual(ticket.options[1].outcomeOnlyVerification, true);
    assert.strictEqual(ticket.refusedOptions.length, 2);
    assert.ok(result.warnings.some((w) => w.kind === "outcome-only-verification"));
    assert.strictEqual(ticket.diagnosis.stateMovedDuringDiagnosis, false, "nothing else was writing this fixture");
    assert.strictEqual(ticket.diagnosis.attempts, 1);
    // This scripted role answers in prose, and the backstop found it. The point of recording which
    // half carried the answer is that both halves still work — the button is the door, the parser is
    // the net under it, and a reader can tell which one was needed.
    assert.strictEqual(ticket.diagnosis.answeredBy, "prose", "the prose backstop still catches an answer given the old way");
    assert.deepStrictEqual(ticket.diagnosis.answerToolRefusals, [], "nothing was refused by the button on this turn");
    // The record of how the turn ran replaced the record of the cap it ran under. A turn that ran
    // under a cap this role no longer has would state a limit that does not exist.
    const shape = ticket.diagnosis.turnShape;
    assert.ok(shape, "the turn's shape is recorded next to the answer");
    assert.strictEqual(shape.chunks, 1, "three scripted steps fit inside one chunk");
    assert.ok(shape.toolCalls >= 5, `the reads and the refused writes are counted: ${shape.toolCalls}`);
    assert.strictEqual(shape.offloads, 0, "a short turn never needed to set a read aside");
    assert.strictEqual(shape.endedAs, "complete", "the harness's own word for how the turn ended");
    assert.ok(ticket.diagnosis.usage, "the turn's token usage is recorded next to the answer");
  } finally {
    await backend.close();
  }
}

// ─── 11. One diagnosis per ticket unless somebody asks for a second ───────────

async function scenarioReaskingIsRefusedWithoutTheFlag() {
  const { root, seriesDir } = await fixtureRoot("reask");
  const paths = { json: path.join(root, "tickets.json"), markdown: path.join(root, "tickets.md") };
  const created = tickets.createTicket(fixtureTicket(), paths);
  tickets.recordDiagnosis(created.ticket.id, cloneDiagnosis(), paths);

  // No model call is reached: the refusal happens before the agent is built.
  const again = await diagnostics.diagnoseTicket({ ticketId: created.ticket.id, seriesDir, root, paths });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.refused, true, "this is a refused request, not a failed answer");
  assert.ok(/already has a diagnosis/.test(again.error), again.error);
  assert.ok(/--reask/.test(again.error), "and it names the way to ask again: " + again.error);

  const closed = tickets.closeTicket(
    created.ticket.id,
    { outcome: "unchanged", note: "nothing moved, so the decision goes to the account owner" },
    paths
  );
  assert.ok(closed.written, closed.error);
  const afterClose = await diagnostics.diagnoseTicket({ ticketId: created.ticket.id, seriesDir, root, paths });
  assert.strictEqual(afterClose.refused, true);
  assert.ok(/closed/.test(afterClose.error), afterClose.error);

  const missing = await diagnostics.diagnoseTicket({ ticketId: "TCK-nope-1", seriesDir, root, paths });
  assert.strictEqual(missing.refused, true);
  assert.ok(/node diagnose.js --open/.test(missing.error), "a refusal says what to run instead");
}

async function scenarioAnUnparseableAnswerIsAFailureNotAnEmptyDiagnosis() {
  const { root, seriesDir } = await fixtureRoot("bad-reply");
  const paths = { json: path.join(root, "tickets.json"), markdown: path.join(root, "tickets.md") };
  const created = tickets.createTicket(fixtureTicket(), paths);

  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => {
      const toolSteps = req.messages.filter((m) => m.role === "tool").length;
      if (toolSteps === 0) return { text: "", toolCalls: [{ name: "readFile", arguments: { filePath: "glossary.js" } }] };
      return { text: "I looked into it. The guard seems overly strict to me; you should relax it." };
    },
  });
  backend.pointEnvAt();
  try {
    const result = await diagnostics.diagnoseTicket({ ticketId: created.ticket.id, seriesDir, root, paths });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.refused, false, "the request was legitimate; the ANSWER failed");
    assert.ok(result.problems.length, JSON.stringify(result.problems));
    const ticket = tickets.readTickets(paths.json).tickets[0];
    assert.strictEqual(ticket.diagnosis, undefined, "nothing was written to the ticket");
    assert.strictEqual(ticket.status, "open", "and it is still waiting for an answer");
  } finally {
    await backend.close();
  }
}

// ─── 11c. The answer arrives through the button, not out of the prose ─────────

/**
 * The role calls `submit_diagnosis` and the ticket keeps what it passed. This is the path that
 * replaces the scrape: the provider checks the fields before this code ever sees them, the answer is
 * on the record before the turn's closing sentence exists, and a second call is refused by the tool
 * rather than becoming a second diagnosis nobody assessed.
 */
async function scenarioTheAnswerArrivesAsAToolCall() {
  const { root, seriesDir } = await fixtureRoot("answer-tool");
  const paths = { json: path.join(root, "tickets.json"), markdown: path.join(root, "tickets.md") };
  const created = tickets.createTicket(fixtureTicket(), paths);

  const submitted = {
    cause:
      "The carry-forward gate compares the new glossary with the copy from the volume before it, and " +
      "for this volume that copy was never written, so the comparison had nothing to compare against.",
    options: [
      {
        label: "Re-run the glossary step with the previous volume's glossary in place",
        touches: ["Test Story(15)/glossary.md"],
        cost: "cheap",
        risk: "Nothing: it repeats work that already ran.",
        verify: "The term count in the volume 15 glossary report goes up.",
      },
    ],
    recommend: "Re-run the glossary step with the previous volume's glossary in place",
    questions: ["Was volume 15 meant to be in the series at all?"],
    read: ["glossary.js"],
    ownerNote: "",
  };

  const backend = await startFakeBackend({
    model: "stub",
    reply: (req) => {
      const toolSteps = req.messages.filter((m) => m.role === "tool").length;
      if (toolSteps === 0) return { text: "", toolCalls: [{ name: "readFile", arguments: { filePath: "glossary.js" } }] };
      if (toolSteps === 1) return { text: "", toolCalls: [{ name: "submit_diagnosis", arguments: submitted }] };
      if (toolSteps === 2) {
        // The role tries to answer again, with a tidier cause. The tool refuses it.
        return {
          text: "",
          toolCalls: [
            { name: "submit_diagnosis", arguments: { ...submitted, cause: "A neater cause, written after the answer was already given." } },
          ],
        };
      }
      return { text: "That is the diagnosis." };
    },
  });
  backend.pointEnvAt();
  try {
    const result = await diagnostics.diagnoseTicket({ ticketId: created.ticket.id, seriesDir, root, paths });
    assert.ok(result.ok, `${result.error}\n${result.problems.map((p) => p.message).join("\n")}`);

    const diagnosis = result.ticket.diagnosis;
    assert.strictEqual(diagnosis.answeredBy, "tool", "the record says which half of the channel carried the answer");
    assert.strictEqual(
      diagnosis.cause,
      submitted.cause,
      "the answer is what was passed, not what a parser found in the reply"
    );
    const options = result.ticket.options;
    assert.strictEqual(options.length, 1, JSON.stringify(options));
    assert.strictEqual(options[0].verify, submitted.options[0].verify, "the five fields arrive intact");
    assert.strictEqual(options[0].cost, "cheap");
    assert.deepStrictEqual(diagnosis.questions, submitted.questions);
    assert.deepStrictEqual(diagnosis.read, ["glossary.js"]);

    // The second call is refused by the tool, and the refusal is recorded rather than swallowed.
    assert.strictEqual(diagnosis.answerToolRefusals.length, 1, JSON.stringify(diagnosis.answerToolRefusals));
    assert.strictEqual(diagnosis.answerToolRefusals[0].kind, "second-answer");
    assert.ok(
      !diagnosis.cause.includes("after the fact"),
      "the first answer is the one the ticket keeps — a second one would be a diagnosis nobody assessed"
    );

    // And the ticket still went through the only door: the banned-option filter ran on the way in.
    assert.ok(options[0].label, "the option is the one the manager is offered");
  } finally {
    await backend.close();
  }
}

// ─── 12. The CLI ──────────────────────────────────────────────────────────────

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "diagnose.js"), ...args], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function scenarioCli() {
  const { root, seriesDir } = await fixtureRoot("cli");
  const postmortem = path.join(root, "postmortem");
  const paths = { json: path.join(postmortem, "tickets.json"), markdown: path.join(postmortem, "tickets.md") };
  const env = { POSTMORTEM_DIR: postmortem, SERIES_LOCATION: seriesDir };

  const created = tickets.createTicket(fixtureTicket(), paths);

  const listed = await runCli(["--open"], env);
  assert.strictEqual(listed.code, 0, listed.err);
  assert.ok(listed.out.includes(created.ticket.id), listed.out);
  assert.ok(listed.out.includes("1 waiting"), listed.out);

  const unknown = await runCli(["--dry-run"], env);
  assert.strictEqual(unknown.code, 2, `${unknown.code}\n${unknown.out}${unknown.err}`);
  assert.ok(/unknown flag/.test(unknown.err), unknown.err);

  const noTicket = await runCli([], env);
  assert.strictEqual(noTicket.code, 2, noTicket.err);

  // Answering a ticket that has not been diagnosed yet: refused request, exit 2.
  const premature = await runCli(["--ticket=" + created.ticket.id, "--answer=volume 15 has no glossary.md"], env);
  assert.strictEqual(premature.code, 2, `${premature.code}\n${premature.out}${premature.err}`);
  assert.ok(/has not been diagnosed/.test(premature.err), premature.err);

  // The diagnosis, written without a model call so the CLI is tested on a real answered ticket.
  const answered = tickets.recordDiagnosis(created.ticket.id, cloneDiagnosis(), paths);
  assert.ok(!answered.error, answered.error);

  const badAnswer = await runCli(
    ["--ticket=" + created.ticket.id, "--answer=the transcript says it reconciled them", "--cites=.logs/run-1/turn-001.md"],
    env
  );
  assert.strictEqual(badAnswer.code, 2, `${badAnswer.code}\n${badAnswer.out}${badAnswer.err}`);
  assert.ok(/unknown flag/.test(badAnswer.err), "there is no --cites flag: an answer cites nothing by default");

  const goodAnswer = await runCli(
    ["--ticket=" + created.ticket.id, '--answer=volume 15 holds glossary.md.rejected and no glossary.md'],
    env
  );
  assert.strictEqual(goodAnswer.code, 0, `${goodAnswer.code}\n${goodAnswer.out}${goodAnswer.err}`);
  assert.ok(goodAnswer.out.includes("Answered on"), goodAnswer.out);

  const reask = await runCli(["--ticket=" + created.ticket.id], { ...env, AI_BASE_URL: "http://127.0.0.1:1/v1" });
  assert.strictEqual(reask.code, 2, `${reask.code}\n${reask.out}${reask.err}`);
  assert.ok(/already has a diagnosis/.test(reask.err), reask.err);
  assert.ok(!/ECONNREFUSED/.test(reask.err), "it refused before reaching any endpoint: " + reask.err);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

const scenarios = [
  ["the role is handed three read tools and no write tools", scenarioOnlyReadToolsAreAdvertised],
  ["the gate refuses and records every write", scenarioGateRefusesAndRecordsEveryWrite],
  ["the read-only set can read the code and the transcripts", scenarioReadOnlyToolsCanActuallyReadEverything],
  ["the reply contract: what refuses, what warns", scenarioReplyContract],
  ["an outcome-only check is flagged, not hidden", scenarioOutcomeOnlyVerificationIsFlaggedNotRefused],
  ["banned options are refused by name and stay visible", scenarioBannedOptionsRefusedAndKept],
  ["an answer with nothing usable is not an answer", scenarioEveryOptionRefusedIsNotAnAnswer],
  ["a cited file the turn never opened is reported", scenarioCrossChecksReads],
  ["the manager's answers are checked on what they cite", scenarioManagerAnswersAreCheckedOnTheAnswer],
  ["the turn has no step cap and no token budget", scenarioTheDiagnosisTurnHasNoStepCap],
  ["a real turn leaves the fixture byte-identical", scenarioRealTurnStaysReadOnly],
  ["one diagnosis per ticket unless --reask", scenarioReaskingIsRefusedWithoutTheFlag],
  ["an unparseable answer is a failed check, not an empty diagnosis", scenarioAnUnparseableAnswerIsAFailureNotAnEmptyDiagnosis],
  ["the answer arrives as a tool call, and a second one is refused", scenarioTheAnswerArrivesAsAToolCall],
  ["the CLI: exit codes and refusals", scenarioCli],
];

async function main() {
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  for (const [label, run] of scenarios) {
    try {
      await run();
      console.log(`ok  ${label}`);
    } catch (err) {
      console.error(`\nFAILED: ${label}`);
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  }
  console.log(`\ntest-diagnostics.js: ${scenarios.length} scenarios passed.`);
}

main();
