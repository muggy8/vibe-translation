/**
 * What the manager reads: a proposal as a document, including the checks that never ran and the attempts the machine refused before this one. The manager is the role that cannot read code, so the report is the whole of what it can check.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const path = require("path");

const { UNJUDGED_STATUSES } = require("./rules");

/**
 * The proposal as the manager reads it: no diff, no code, and every number in units it can check.
 *
 * @param {Patch} patch
 * @returns {string}
 */
function renderProposalMarkdown(patch) {
  const lines = [
    `### ${patch.id} — ${patch.step}${patch.volume ? ` volume ${patch.volume}` : ""} — ${patch.finding}`,
    `Status: ${patch.status}`,
    ``,
    `**Answers:** ${patch.ticketId}, option ${patch.optionId}${patch.optionLabel ? ` ("${patch.optionLabel}")` : ""}`,
    patch.chosenReason ? `**Why the manager chose that option:** ${patch.chosenReason}` : "",
    ``,
    `**What changed:**`,
    patch.summary || "*(not stated)*",
    ``,
    `**The mechanism it fixes:**`,
    patch.why || "*(not stated)*",
    ``,
    `**Files it touched:**`,
    ...((patch.files || []).length ? patch.files.map((f) => `- \`${f}\``) : ["*(none declared)*"]),
    ``,
    `**What it could break:**`,
    patch.couldBreak || "*(not stated)*",
    ``,
    `**What it expects to move in the deliverable:**`,
    ...((patch.expected || []).length
      ? patch.expected.map((e) => `- \`${e.signal}\` ${e.direction} — ${e.why}`)
      : ["*(nothing stated)*"]),
    ``,
    `**How the manager checks it:**`,
    patch.verify || "*(not stated)*",
  ];

  if ((patch.questions || []).length) {
    lines.push(``, `**Questions back to the manager:**`);
    for (const q of patch.questions) lines.push(`- ${q}`);
  }
  if (patch.ownerNote) {
    lines.push(``, `**For the account owner only** (not something the manager may accept):`, patch.ownerNote);
  }

  lines.push(``, `**The checks the machine ran:**`);
  if ((patch.checks || []).length) {
    for (const c of patch.checks) {
      lines.push(`- \`${c.command}\` → ${c.passed ? "passed" : `FAILED (exit ${c.exitCode === null ? "never ran" : c.exitCode})`}`);
      if (!c.passed && c.tail) lines.push(`  - ${String(c.tail).split("\n").slice(-3).join("\n  - ")}`);
    }
  } else {
    lines.push("- *(none yet — run `npm run fix -- --verify=" + patch.id + "`)*");
  }
  // A check that never ran is not the same as a check that passed, and a list of only the ones that
  // ran reads like the whole gate did. The verdict is printed next to the list so the manager cannot
  // infer "green" from a short one.
  const verdict = patch.checkVerdict;
  if (verdict && (verdict.missing.length || verdict.failed.length)) {
    if (verdict.missing.length) lines.push(`- **never ran:** ${verdict.missing.join(", ")}`);
    if (verdict.failed.length) lines.push(`- **failed:** ${verdict.failed.join(", ")}`);
    lines.push(`- This patch is ${verdict.accepted ? "not blocked by its checks" : "not acceptable yet"}.`);
  }

  if ((patch.refusedWrites || []).length) {
    lines.push(``, `**Writes the sandbox gate stopped during that turn:**`);
    for (const w of patch.refusedWrites) lines.push(`- \`${w.tool}\` on \`${w.path}\` — ${w.reason}`);
  }
  if ((patch.refusedPaths || []).length) {
    lines.push(``, `**Files this patch was refused for touching:**`);
    for (const b of patch.refusedPaths) lines.push(`- \`${b.file}\` — ${b.because}\n  - goes to: ${b.escalateTo}`);
  }
  if ((patch.warnings || []).length) {
    lines.push(``, `**Warnings:**`);
    for (const w of patch.warnings) lines.push(`- ${w.message}`);
  }
  if ((patch.problems || []).length) {
    lines.push(``, `**Why this proposal was refused:**`);
    for (const p of patch.problems) lines.push(`- ${p.message}`);
  }
  if ((patch.refusedAttempts || []).length) {
    lines.push(``, `**Attempts the machine refused before this one** (kept so a stopped attempt is not mistaken for nobody trying):`);
    for (const a of patch.refusedAttempts) {
      const files = (a.files || []).length ? a.files.map((f) => `\`${f}\``).join(", ") : "no files named";
      lines.push(`- ${a.at}, ${files}:`);
      for (const p of a.problems || []) lines.push(`  - refused: ${p.message}`);
      for (const w of a.warnings || []) lines.push(`  - warned: ${w.message}`);
    }
  }
  if (patch.decision) {
    lines.push(``, `**Decision:** ${patch.decision.outcome} by ${patch.decision.decidedBy} — ${patch.decision.reason}`);
  }
  if (patch.commit) {
    lines.push(``, `**Committed:** \`${patch.commit.hash}\` (${patch.commit.files.length} file(s)) at ${patch.commit.at}`);
  }
  if (patch.reverted) {
    lines.push(
      ``,
      `**Reverted:** ${patch.reverted.restored.length} file(s) restored from git` +
        (patch.reverted.leftBehind.length
          ? `. Still in the tree, created by this patch, for the account owner to remove: ${patch.reverted.leftBehind.map((f) => `\`${f}\``).join(", ")}`
          : "")
    );
  }
  if (patch.turnShape || patch.usage) {
    const u = patch.usage || {};
    const s = patch.turnShape;
    const ran = s
      ? `${s.toolCalls} tool call(s) over ${s.chunks} chunk(s), no step cap` +
        (s.offloads
          ? `, ${s.offloads} read answer(s) set aside on disk (${s.offloadedTokens} tokens)`
          : "") +
        `, ended: ${s.endedAs || "not recorded"}`
      : "shape not recorded";
    lines.push(``, `*Dev turn: ${ran}; ${u.input || "?"} input / ${u.output || "?"} output tokens.*`);
  }
  return lines.filter((l) => l !== "").join("\n");
}


/**
 * @param {Patch} patch
 * @returns {string}
 */
function renderPatchMarkdown(patch) {
  return renderProposalMarkdown(patch) + "\n";
}


/**
 * Every patch as Markdown, newest last — the file a human reads.
 *
 * The list is REQUIRED here on purpose, for the same reason as `renderTicketsMarkdown`: a
 * renderer that reads the channel when nobody hands it one makes `writePatches` and its own
 * report import each other. "No list means the one on disk" is supplied by the public face
 * (`utils/patches.js`), where a caller looks for it.
 *
 * @param {Patch[]} patches
 * @returns {string}
 */
function renderPatchesMarkdown(patches) {
  const header = [
    "# Patch proposals",
    "",
    "What the dev team changed, why, what it could break, and what the machine ran to prove it.",
    "The delivery manager accepts or rejects these; it never applies one, and only the dev team commits.",
    "",
  ];
  if (!patches.length) {
    return `${header.join("\n")}No patches. Nothing has been proposed, so nothing is waiting in the working tree.\n`;
  }
  const pending = patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
  // A rejected patch is judged, but its edits are still in the tree until somebody reverts them, and
  // the tree is what the next run executes. Saying "nothing unjudged" while that is true would be the
  // one sentence in this file that is actively wrong.
  const unreverted = patches.filter((p) => p.status === "rejected" && !p.reverted);
  let headline;
  if (pending.length) {
    headline =
      `**${pending.length} unjudged change(s) in the working tree of \`main\`:** ${pending
        .map((p) => `${p.id} (${p.status})`)
        .join(", ")}. The pipeline runs whatever is in this tree, so act mode refuses to run a step while one is waiting.`;
  } else if (unreverted.length) {
    headline =
      `**${unreverted.length} rejected patch(es) still in the working tree:** ${unreverted
        .map((p) => p.id)
        .join(", ")}. The manager said no to this code and it is still what the next run would execute. ` +
      `Put it back: ${unreverted.map((p) => `npm run fix -- --revert=${p.id}`).join("  ")}`;
  } else {
    headline = "Nothing unjudged is in the working tree.";
  }
  const body = [headline, "", ...patches.map(renderProposalMarkdown)];
  return `${header.join("\n")}${body.join("\n")}\n`;
}

// ─── Path helpers ─────────────────────────────────────────────────────────────


module.exports = {
  renderProposalMarkdown,
  renderPatchMarkdown,
  renderPatchesMarkdown,
};
