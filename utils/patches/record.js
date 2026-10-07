/**
 * The channel file and the reads every other role depends on: patches.json, finding a patch by id, and the two lists act mode reads — a `proposed` patch is live code in the tree, so an unjudged one gates the whole plan.
 *
 * Part of the patches.js layer (split out of the original single file).
 */

const fs = require("fs");
const path = require("path");
const { postMortemDir } = require("../postmortem");
const { readTickets, ticketPaths } = require("../tickets");

const { renderPatchesMarkdown } = require("./render");
const { UNJUDGED_STATUSES } = require("./rules");

/**
 * @returns {{json: string, markdown: string}} Where patches live: beside the tickets and the ledger.
 */
function patchPaths() {
  const dir = postMortemDir();
  return { json: path.join(dir, "patches.json"), markdown: path.join(dir, "patches.md") };
}


/**
 * Read the patch file. A corrupt record is reported, never reported as "no patches" — the same rule
 * as `readTickets` and `readUsableManifest` (gotcha 33/69): an empty-looking history is how a decision
 * disappears.
 *
 * @param {string} [filePath]
 * @returns {{patches: Patch[], error: string|null}}
 */
function readPatches(filePath = patchPaths().json) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { patches: [], error: null };
    return { patches: [], error: `cannot read ${filePath}: ${err.message}` };
  }
  if (!raw.trim()) return { patches: [], error: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { patches: [], error: `${filePath} does not parse (${err.message}). It is not being treated as empty.` };
  }
  if (!parsed || !Array.isArray(parsed.patches)) {
    return { patches: [], error: `${filePath} has no "patches" array. It is not being treated as empty.` };
  }
  return { patches: parsed.patches, error: null };
}


/**
 * Write the patch file, and the human-readable half beside it.
 *
 * @param {Patch[]} patches
 * @param {{json: string, markdown: string}} [paths]
 * @returns {{written: boolean, error: string|null}}
 */
function writePatches(patches, paths = patchPaths()) {
  try {
    fs.mkdirSync(path.dirname(paths.json), { recursive: true });
    fs.writeFileSync(paths.json, JSON.stringify({ patches, writtenAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    fs.writeFileSync(paths.markdown, renderPatchesMarkdown(patches), "utf8");
    return { written: true, error: null };
  } catch (err) {
    return { written: false, error: `cannot write ${paths.json}: ${err.message}` };
  }
}


/**
 * @param {string} id
 * @param {Patch[]} [patches]
 * @returns {Patch|null}
 */
function findPatch(id, patches = readPatches().patches) {
  return (patches || []).find((p) => p.id === id) || null;
}


/**
 * Patches whose change is sitting in the working tree with nobody having said whether it stays.
 *
 * This is the guard act mode runs against: the working tree of `main` is what `npm run pipeline`
 * executes, so running a step while a patch is unjudged runs code the manager has not accepted.
 *
 * @param {{json: string, markdown: string}} [paths] - A patch file other than the live one (a test fixture).
 * @returns {Patch[]}
 */
function pendingPatches(paths = patchPaths()) {
  return readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
}


/**
 * Patches whose code is still in the working tree with nobody having accepted it.
 *
 * Wider than `pendingPatches`, and the difference is the point: a REJECTED patch is judged, but its
 * edits are still sitting in the tree until somebody reverts them. Running a step while that is true
 * runs code the manager said no to. So the list act mode refuses against is "unjudged, or refused and
 * not yet put back".
 *
 * @param {{json: string, markdown: string}} [paths]
 * @returns {Patch[]}
 */
function unresolvedPatches(paths = patchPaths()) {
  return readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status) || (p.status === "rejected" && !p.reverted));
}


/**
 * @param {string} ticketId
 * @param {{json: string, markdown: string}} [paths]
 * @returns {Patch|null}
 */
function patchForTicket(ticketId, paths = patchPaths()) {
  return readPatches(paths.json).patches.find((p) => p.ticketId === ticketId) || null;
}

// ─── The door ─────────────────────────────────────────────────────────────────


/**
 * Open a patch for a ticket. The only way a code change gets requested in this pipeline.
 *
 * The manager does not describe a fix. It chose an option the diagnostics team offered, and that
 * option said it needs a code change; this reads that choice and nothing else. A ticket with
 * `noUsableOptions` is refused on purpose: every option was refused because the decision belongs to
 * the account owner, and a dev team summoned onto that ticket would be doing the account owner's
 * job for them (gotcha 70).
 *
 * @param {Object} input
 * @param {string} input.ticketId
 * @param {string} [input.optionId] - Defaults to the ticket's recorded choice.
 * @param {{json: string, markdown: string}} [input.paths]
 * @param {Object} [input.ticketPathsOverride]
 * @returns {{patch: Patch|null, error: string|null}}
 */
function createPatch({ ticketId, optionId, paths = patchPaths(), ticketsFile = ticketPaths().json }) {
  const { tickets, error: ticketsError } = readTickets(ticketsFile);
  if (ticketsError) return { patch: null, error: `the ticket channel cannot be read: ${ticketsError}` };

  const ticket = (tickets || []).find((t) => t.id === ticketId);
  if (!ticket) return { patch: null, error: `no ticket ${ticketId}. A patch answers a ticket; there is no other way in.` };
  if (ticket.status === "closed") {
    return { patch: null, error: `ticket ${ticketId} is closed. A closed ticket has an answer already.` };
  }
  if (ticket.status === "open" || !ticket.diagnosis) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no diagnosis yet. The order is: ask, get the options, choose one. A ` +
        `dev team that starts before the diagnosis is guessing at the cause instead of fixing it.`,
    };
  }
  if (ticket.noUsableOptions) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no usable option: every option the diagnostics team offered was refused ` +
        `by the banned-option filter, and what it actually believes is written for the account owner. ` +
        `A dev team cannot be sent to a decision that belongs to the account owner.`,
    };
  }
  if (!ticket.choice) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} has no recorded choice. The manager chooses an option, in writing, with a ` +
        `reason; that choice is what asks for a code change.`,
    };
  }

  const chosen = (ticket.options || []).find((o) => o.id === ticket.choice.optionId);
  if (!chosen) return { patch: null, error: `the chosen option ${ticket.choice.optionId} is not on ticket ${ticketId}.` };
  if (optionId && optionId !== chosen.id) {
    return {
      patch: null,
      error:
        `option ${optionId} was not the one chosen for ${ticketId}. The dev team works on the option the ` +
        `manager chose, not on a different one picked later.`,
    };
  }
  if (!chosen.requiresCodeChange) {
    return {
      patch: null,
      error:
        `option ${chosen.id} ("${chosen.label}") does not need a code change. It is a move the manager ` +
        `can make itself through the action menu — sending it to the dev team would pay a code change ` +
        `for something the manager was already allowed to do.`,
    };
  }

  const existing = patchForTicket(ticketId, paths);
  if (existing) {
    return {
      patch: null,
      error:
        `ticket ${ticketId} already has ${existing.id} (${existing.status}). One team at a time: a second ` +
        `patch on the same ticket would put two unjudged changes in the same working tree.`,
    };
  }

  const open = readPatches(paths.json).patches.filter((p) => UNJUDGED_STATUSES.includes(p.status));
  if (open.length) {
    return {
      patch: null,
      error:
        `${open.map((p) => `${p.id} (${p.status}, ticket ${p.ticketId})`).join(", ")} is already in the ` +
        `working tree, unjudged. One team at a time — the tree is what the next run executes, and two ` +
        `unjudged changes in it cannot be judged separately. Accept or reject ${open[0].id} first.`,
    };
  }

  const all = readPatches(paths.json).patches;
  const patch = {
    id: `PATCH-${String(all.length + 1).padStart(3, "0")}`,
    ticketId,
    optionId: chosen.id,
    optionLabel: chosen.label,
    step: ticket.step,
    volume: ticket.volume || null,
    finding: ticket.finding,
    status: "proposed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    files: [],
    chosenReason: ticket.choice.reason,
  };

  const written = writePatches([...all, patch], paths);
  if (written.error) return { patch: null, error: written.error };
  return { patch, error: null };
}

// ─── The proposal lands ───────────────────────────────────────────────────────


module.exports = {
  patchPaths,
  readPatches,
  writePatches,
  findPatch,
  pendingPatches,
  unresolvedPatches,
  patchForTicket,
  createPatch,
};
