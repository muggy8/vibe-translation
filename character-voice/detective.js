/**
 * character-voice/detective.js — the one part of the attribution feature that asks the model anything.
 *
 * `utils/reference-store/attribution.js` can say, from the record alone, that a volume filed claims
 * under a name its own text does not contain. It cannot say who is speaking, and it is deliberately not
 * written to guess: the obvious rule (a name inside a quote is the speaker) was measured against both
 * real records and is wrong on every example it produced. Answering the question means reading the
 * scene, and reading a scene is a model call.
 *
 * So the call is bounded, in four directions, and none of the four has an environment knob (AGENTS.md
 * rule 3 — a guard the role can switch off is not a guard):
 *
 *   - **per group, not per claim, chapter, or character.** The doubt is a property of one roster entry
 *     in one volume. Volume 02's six 蒲田 claims were read in one scene and are answered in one call.
 *   - **`DETECTIVE_MAX_GROUPS` per run.** A volume whose record is badly wrong gets three groups read,
 *     not an unbounded queue, and the report says which groups were not asked.
 *   - **`DETECTIVE_MAX_STEPS` per call.** The passage is handed to the agent in the request; the steps
 *     are for checking, not for wandering.
 *   - **`DETECTIVE_TOKEN_BUDGET` per run.** Prompt tokens, counted from the model's own usage numbers.
 *     When the budget is spent the remaining groups are reported as unanswered rather than paid for.
 *
 * What the agent may do is read, and only in the volume's own folder. The write tools are not offered
 * at all — the sandbox would refuse them, and advertising a tool the gate would deny is the shape
 * AGENTS.md gotcha 60 names — and the approve predicate refuses every mutating call as well, so the
 * gate is strictly tighter than the one a stage agent gets.
 *
 * What the agent may not do is decide. Its answer is filed in `attribution_answers`, and an answer that
 * disagrees with the record opens a `challenge_fact` row per claim, which stays **open**: the reference
 * keeps saying what it says until a person closes the dispute. A model that could settle a published
 * claim by answering a question is a model that edits published history.
 *
 * @module character-voice/detective
 */

require("../configs/env-defaults").bootstrapEnv();
require("../types"); // JSDoc type definitions
const fs = require("fs").promises;
const path = require("path");

const harness = require("../harness");
const rs = require("../utils/reference-store");
const projectRoot = path.resolve(__dirname, "..");

/** The detective's system prompt. */
const DETECTIVE_SYSTEM_PROMPT_FILE = path.join(projectRoot, "system-prompts", "character-voice-detective.md");

/**
 * How many tool calls one attribution question is allowed.
 *
 * The passage around each cited line is already in the request. The steps are for checking a name or
 * reading a little further, and an agent that spends eight of them reading chapters has not answered the
 * question — it has started a different one.
 *
 * @type {number}
 */
const DETECTIVE_MAX_STEPS = 8;

/**
 * How many doubted roster entries one run may ask about.
 *
 * A volume whose record is wrong in this way usually got it wrong more than once. Reading three of them
 * is a decision an owner can defend on cost; reading all of them is a queue with no ceiling, and the
 * ceiling is what makes the cost of this feature knowable before running it.
 *
 * @type {number}
 */
const DETECTIVE_MAX_GROUPS = 3;

/**
 * The prompt-token ceiling for one run, counted from the model's own usage numbers.
 *
 * Measured against what the rest of this stage costs: one acceptance grade of volume 02's reference is
 * about 51,000 prompt tokens, and the gate takes three of them. This budget is roughly two grades, and
 * it is what a bounded read of a handful of scenes should land well inside. When it is spent the run
 * stops and names the groups it did not ask about; it does not quietly keep paying.
 *
 * @type {number}
 */
const DETECTIVE_TOKEN_BUDGET = 120000;

/**
 * How many source lines around a cited line the request carries.
 *
 * "Who is speaking this line" is answered by the lines beside it. The window is what lets the answer be
 * cheap; the agent can still read further with its own tools, and the prompt says it may.
 *
 * @type {number}
 */
const DETECTIVE_CONTEXT_LINES = 14;

/**
 * The file tools a read-only role is offered: the reading half, with the writing half removed.
 *
 * The gate would refuse a write from this role anyway. Removing the tools is the other half of the rule
 * AGENTS.md gotcha 60 states — a tool list the sandbox would contradict is a promise the agent spends
 * steps discovering is false.
 *
 * @param {string} volumeDir
 * @returns {Promise<{tools: Object, approve: Function}>}
 */
async function readOnlyFsGate(volumeDir) {
  const gate = await harness.createGatedFsTools({ cwd: volumeDir, allowedDirs: [volumeDir] });
  const tools = { ...gate.tools };
  for (const name of ["writeFile", "editFile", "deleteFile"]) delete tools[name];
  const approve = (call) => {
    const mutating = ["writeFile", "editFile", "deleteFile"].includes(call && call.toolName);
    if (mutating) return false;
    return gate.approve(call);
  };
  return { tools, approve };
}

/**
 * The request: the claims on trial, the passage each one cites, the roster the answer may name, and the
 * shape the answer has to take.
 *
 * The passage is deduplicated by chapter and line, because volume 02's six claims cite three lines and
 * pasting the same scene six times would be six times the cost for the same reading.
 *
 * @param {Object} store - An open reference store, for the roster and the passage windows.
 * @param {Object} group - One row from `attributionDoubts().groups`.
 * @returns {string}
 */
function buildDetectivePrompt(store, group) {
  const roster = store.db
    .prepare("SELECT key, display, aliases FROM cast WHERE merged_into IS NULL ORDER BY key")
    .all()
    .map((row) => {
      let aliases = [];
      try {
        aliases = JSON.parse(row.aliases || "[]");
      } catch {
        aliases = [];
      }
      return `- ${row.key}${row.display && row.display !== row.key ? ` (${row.display})` : ""}${aliases.length ? ` — also recorded as: ${aliases.join(", ")}` : ""}`;
    });

  /** @type {Map<string, {chapter: string, line: number, window: Array<{line: number, text: string, cited: boolean}>}>} */
  const passages = new Map();
  for (const claim of group.claims) {
    if (!claim.chapter || !Number.isInteger(claim.line)) continue;
    const id = `${claim.chapter}:${claim.line}`;
    if (passages.has(id)) continue;
    const passage = store.speakerPassage({ volume: group.volume, chapter: claim.chapter, line: claim.line, radius: DETECTIVE_CONTEXT_LINES });
    if (passage.error) continue;
    passages.set(id, { chapter: claim.chapter, line: claim.line, window: passage.window });
  }

  const claims = group.claims.map(
    (claim) =>
      `- ${claim.id} (${claim.aspect}${claim.label ? `, ${claim.label}` : ""}) cites ${claim.chapter}:${claim.line} ` +
      `— that line is ${claim.speechKind === "dialogue" ? "a line of dialogue" : "narration"} — and says: ${claim.body}`
  );

  const passageBlocks = [...passages.values()].map((passage) => {
    const lines = passage.window.map((row) => `${row.cited ? ">>" : "  "} ${row.line}: ${row.text}`);
    return `### ${passage.chapter}, around line ${passage.line}\n\n${lines.join("\n")}`;
  });

  return (
    `## The question\n\n` +
    `Volume ${group.volume}'s reference record filed ${group.claimCount} claim(s) under the character ` +
    `**${group.key}** (${group.display}). The record's own measurement of volume ${group.volume}'s text ` +
    `does not find that name anywhere in the volume, so the record cannot say whether these claims belong ` +
    `to this character.\n\n` +
    (group.readingAids && group.readingAids.found
      ? `One thing is already known: the name IS printed in this volume — ${group.readingAids.hits
          .slice(0, 3)
          .map((hit) => `「${hit.span}」 at ${hit.chapter}:${hit.line}`)
          .join(", ")} — with reading aids written between its kanji. If the scene shows this character ` +
        `speaking the quoted lines, the answer is \`confirmed\`.\n\n`
      : "") +
    `## The claims on trial\n\n${claims.join("\n")}\n\n` +
    `## The passage they cite\n\n${passageBlocks.join("\n\n")}\n\n` +
    `## The roster you may name\n\n${roster.join("\n")}\n\n` +
    `Only a name from that list counts as a character. If the words are the narration's, answer ` +
    `\`narrator\` — that is not a character and must not be named as one.\n\n` +
    `You may search this volume's chapter files with grep and read a range with readFile if the passage ` +
    `above is not enough. Reply with only the JSON object.`
  );
}

/**
 * Read the detective's answer out of its reply.
 *
 * Strict, and it says what it could not read. A half-parsed answer would be filed as a finding against a
 * published claim, so a reply that does not produce the four fields is reported as a failure to answer
 * rather than repaired by guessing at what the model meant.
 *
 * @param {string} reply - The agent's final text.
 * @returns {{ok: boolean, answer: Object|null, error: string|null}}
 */
function parseDetectiveReply(reply) {
  const text = String(reply || "");
  const starts = [...text.matchAll(/\{/g)].map((m) => m.index);
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    let depth = 0;
    let end = -1;
    for (let j = starts[i]; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(text.slice(starts[i], end + 1));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const answer = String(parsed.answer || "").trim();
    if (!["confirmed", "reassign", "narrator", "unknown"].includes(answer)) continue;
    return {
      ok: true,
      answer: {
        answer,
        speaker: parsed.speaker === undefined || parsed.speaker === null ? null : String(parsed.speaker).trim() || null,
        reason: String(parsed.reason || "").trim(),
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      },
      error: null,
    };
  }
  return {
    ok: false,
    answer: null,
    error: `the reply did not contain a JSON object with an "answer" of confirmed / reassign / narrator / unknown: ${text.trim().slice(0, 240)}`,
  };
}

/**
 * Ask about the doubts one volume's record holds, and file the answers.
 *
 * @param {Object} opts
 * @param {Object} opts.store - The volume's open reference store.
 * @param {number} opts.volume
 * @param {string} opts.volumeDir
 * @param {Function} [opts.log]
 * @returns {Promise<{ok: boolean, asked: number, skipped: Array<Object>, results: Array<Object>, promptTokens: number, completionTokens: number, totalTokens: number, budgetReached: boolean, error: string|null}>}
 */
async function resolveAttributionDoubts({ store, volume, volumeDir, log = console.log }) {
  const vol = Number(volume);
  const doubts = store.attributionDoubts({ volume: vol });
  const base = {
    ok: true,
    asked: 0,
    skipped: [],
    results: [],
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    budgetReached: false,
    error: null,
  };
  if (!doubts.asked) return { ...base, error: doubts.because };

  const unanswered = doubts.groups.filter((group) => !group.answer);
  const alreadyAnswered = doubts.groups.filter((group) => group.answer);
  for (const group of alreadyAnswered) {
    base.skipped.push({ key: group.key, because: `this record already holds an answer: ${group.answer.answer}${group.answer.speaker ? ` → ${group.answer.speaker}` : ""}` });
  }
  if (unanswered.length === 0) return base;

  const systemPrompt = await fs.readFile(DETECTIVE_SYSTEM_PROMPT_FILE, "utf8");
  const gate = await readOnlyFsGate(volumeDir);

  for (const group of unanswered) {
    if (base.asked >= DETECTIVE_MAX_GROUPS) {
      base.skipped.push({ key: group.key, because: `this run asks at most ${DETECTIVE_MAX_GROUPS} group(s) per volume` });
      continue;
    }
    if (base.promptTokens >= DETECTIVE_TOKEN_BUDGET) {
      base.skipped.push({ key: group.key, because: `the token budget for this run (${DETECTIVE_TOKEN_BUDGET} prompt tokens) is spent` });
      base.budgetReached = true;
      continue;
    }

    log(
      `Volume ${vol}: asking the detective who speaks the ${group.claimCount} claim(s) filed under ` +
        `"${group.key}" (${group.claims.map((c) => `${c.chapter}:${c.line}`).join(", ")}). ` +
        `Read-only tools, at most ${DETECTIVE_MAX_STEPS} steps.`
    );

    const agent = await harness.createAgentHandle({
      name: `attribution-detective-${vol}-${group.key}`,
      systemPrompt,
      tools: gate.tools,
      approve: gate.approve,
      cwd: volumeDir,
      maxSteps: DETECTIVE_MAX_STEPS,
    });
    /** @type {Object|null} */
    let reply = null;
    try {
      reply = await agent.sendTurn(buildDetectivePrompt(store, group), {
        label: `attribution-detective-${vol}-${group.key}`,
      });
    } finally {
      await agent.close();
    }

    const usage = (reply && reply.usage) || {};
    base.promptTokens += Number(usage.inputTokens || 0);
    base.completionTokens += Number(usage.outputTokens || 0);
    base.totalTokens += Number(usage.totalTokens || 0);
    base.asked += 1;

    const parsed = parseDetectiveReply(reply && reply.text);
    if (!parsed.ok) {
      base.results.push({ key: group.key, ok: false, because: parsed.error, claims: group.claimCount });
      log(`Volume ${vol}: the detective did not answer for "${group.key}" — ${parsed.error}`);
      continue;
    }

    const filed = store.recordAttributionAnswer({
      volume: vol,
      key: group.key,
      answer: parsed.answer.answer,
      speaker: parsed.answer.speaker,
      reason: parsed.answer.reason,
      evidence: parsed.answer.evidence,
      claimIds: group.claims.map((claim) => claim.id),
    });
    if (!filed.ok) {
      base.results.push({ key: group.key, ok: false, answer: parsed.answer, because: filed.refusal.because, claims: group.claimCount });
      log(`Volume ${vol}: the answer was not filed — ${filed.refusal.rule}: ${filed.refusal.because}`);
      continue;
    }

    base.results.push({
      key: group.key,
      ok: true,
      answer: parsed.answer.answer,
      speaker: filed.answer.speaker,
      reason: filed.answer.reason,
      challenges: filed.challenges,
      claims: group.claimCount,
    });
    log(
      `Volume ${vol}: the detective answered **${parsed.answer.answer}**` +
        (filed.answer.speaker ? ` → ${filed.answer.speaker}` : "") +
        ` for "${group.key}" (${filed.answer.reason}). ` +
        (filed.challenges.length
          ? `${filed.challenges.length} challenge(s) opened against the claims it answers; they stay open until somebody resolves them.`
          : "No challenge was opened: the record's own answer stands.")
    );
  }

  return base;
}

module.exports = {
  DETECTIVE_SYSTEM_PROMPT_FILE,
  DETECTIVE_MAX_STEPS,
  DETECTIVE_MAX_GROUPS,
  DETECTIVE_TOKEN_BUDGET,
  DETECTIVE_CONTEXT_LINES,
  readOnlyFsGate,
  buildDetectivePrompt,
  parseDetectiveReply,
  resolveAttributionDoubts,
};
