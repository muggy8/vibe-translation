/**
 * utils/devteam/brief.js — what the role is told, and the file that tells it.
 *
 * The boundary in words: which files it may not touch, that it has no shell, that a proposal another
 * program cannot read is not a proposal. The banned-path list and the closed action menu have no env
 * knob on purpose (gotcha 70, gotcha 75), so they live here as constants rather than settings.
 * 
 * The note is appended in code, never in the prompt file: prompt files stay mode-agnostic and
 * role-specific text is added here (AGENTS.md rule 6).
 */

const fs = require("fs");
const path = require("path");

const patches = require("../patches");

const projectRoot = path.join(__dirname, "../.."); // devteam.js's ROOT
const SYSTEM_PROMPT_FILE = path.join(projectRoot, "system-prompts", "devteam.md");

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
 * mode-agnostic, mode-specific text is appended here — see docs/conventions.md).
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
  \`utils/runlock.js\`, \`utils/patches.js\` — the rules that constrain you and the manager. Several of
  them are the cover over a folder of the same name (\`utils/tickets/\`, \`utils/resume/\`,
  \`utils/delivery-verify/\`, \`utils/patches/\`): the ban covers the cover AND everything inside it,
  because rewriting the page inside is the same edit as rewriting the cover.
- \`test/test-tickets.js\`, \`test/test-resume.js\`, \`test/test-delivery-verify.js\`,
  \`test/test-ledger.js\`, \`test/test-delivery-act.js\`, \`test/test-diagnostics.js\`,
  \`test/test-patches.js\` — the tests that prove those rules work.
- \`hooks/\` (per-machine scripts), \`.env\` and \`.env.example\` (the settings), the run's own records
  folder — \`.run/\`, \`.postmortem/\`, \`.logs/\`, \`.dry-run/\`, wherever a series keeps them —
  and \`node_modules/\`.
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
you have already read — if you cannot recall what it said, search what you set aside.

Then hand in the proposal by calling \`submit_proposal\` with these arguments. They ARE the proposal:
the record keeps what you pass them, and the provider checks each one is present before the patch file
ever sees it. A proposal you wrote into your prose is one a parser has to find — after you have already
edited files, which is how a changed working tree ends up with no record of what the team believed it
had done.

\`\`\`
files       ["glossary.js", "utils/prompt.js"]  — every file the patch touched
summary     what changed, in language the manager can repeat
why         the mechanism the patch fixes, not the finding it removes
couldBreak  what this change could damage
expected    [{ signal, direction, why }] — what the patch expects to move in the deliverable
verify      how the manager checks it worked, using something a reader with no code access can look at
questions   what you need from the manager before this is committed
ownerNote   for the account owner alone, or empty
\`\`\`

Call it once, after the change is made. A second call is refused — the record keeps the first.

\`signal\` must be one of the names the acceptance test measures: ${patches.SIGNAL_NAMES.join(
  ", "
)}. Naming a number nobody measures is refused: your claim has to be checkable by the
before/after comparison that already exists, not by a scoreboard you invented.`;

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

module.exports = {
  MUTATING_TOOL_NAMES,
  DELETION_REFUSAL,
  DEVTEAM_TOOLS_NOTE,
  SYSTEM_PROMPT_FILE,
  loadSystemPrompt,
};
