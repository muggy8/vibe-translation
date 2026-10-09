/**
 * configs/run-state.js — where a run keeps its own records.
 *
 * A run produces two kinds of file. The **deliverable** is the glossary, the voice
 * reference, the wiki, the translation: it lives in the series folder, next to the book it
 * describes, and it has always lived there. The **memory** is everything else the run
 * writes: the post-mortem reports, the ledger of what it already tried, the ticket channel,
 * the patch channel, the delivery plan, the run lock, the transcripts of every model call,
 * the `--dry-run` prompt dumps. Until now that memory sat in the CODE's folder
 * (`<repo>/.postmortem`, `<repo>/.logs`, `<repo>/.dry-run`), which is the wrong home for
 * two reasons this file exists to fix:
 *
 *   1. **It is memory ABOUT a series, and the series is a setting.** Change `SERIES_LOCATION`
 *      and the next run is a different series — but its memory was still piled on top of the
 *      previous one's in the same repo folder. Two series sharing one ledger is not a
 *      bookkeeping detail: the anti-spin gate counts attempts per run, the resume triage reads
 *      "what this run already tried", and both were reading the other series' history.
 *   2. **It is the half you want to carry to another machine.** The tickets, the ledger and
 *      the patch records are what a second computer needs in order to continue a run instead
 *      of re-deriving it. They belong in the repository that holds the books, next to the
 *      work they describe — not in the tool's own folder, which is the same on every machine
 *      and says nothing about which series it was about.
 *
 * So the memory now lives in the series folder, in one container:
 *
 *   <SERIES_LOCATION>/.run/
 *     postmortem/   reports, ledger.json, tickets.json/.md, patches.json/.md,
 *                   delivery-plan.md/.json, last-structural-failure.json, run.lock
 *     logs/         the transcripts of every model call (never committed)
 *     dry-run/      the prompts --dry-run would have sent (never committed)
 *     .gitignore    written by the run itself: what of this is not a record
 *
 * One container rather than three dot-folders at the series root, because the series root is
 * scanned for volume folders and every extra name there is one more thing that scan has to
 * recognise (see ./RUN_DIR_NAMES and intake/committed.js).
 *
 * **What deliberately did NOT move: the token-calibration cache.** It measures the tokenizer
 * of the model server THIS machine is pointed at (`AI_BASE_URL`), not anything about the
 * books. Carrying it to the series folder would have a machine that has never met the
 * endpoint trust a measurement taken against someone else's server. It stays in the repo.
 *
 * Every one of these is still overridable (`RUN_DIR`, `POSTMORTEM_DIR`, `LOGS_DIR`,
 * `DRY_RUN_DIR`), because two series at once and a disk you would rather keep the transcripts
 * on are both real setups.
 */

const fs = require("fs");
const path = require("path");

const { projectRoot } = require("./env-defaults");

// ─── The names ────────────────────────────────────────────────────────────────

/** The container folder a run builds inside the series folder. */
const RUN_DIR_NAME = ".run";

/** The three kinds of record the run keeps, as subfolders of that container. */
const RUN_STATE_SUBDIRS = {
  postmortem: "postmortem",
  logs: "logs",
  dryRun: "dry-run",
};

/**
 * Folder names that belong to the run and never to the series.
 *
 * The series root is scanned for volume folders (intake/committed.js,
 * intake/deterministic.js), and that scan treats a directory as a candidate volume — so a
 * run folder it does not recognise becomes a phantom volume holding a phantom book
 * (`tickets.md` looks exactly like a source file to `firstSourceInVolumeDir`). The legacy
 * repo-root names are in this list too: an operator who set `POSTMORTEM_DIR=<series>/.postmortem`,
 * or who has an old `.logs` left in the series folder from before this moved, gets the same
 * protection as the new name.
 *
 * @type {string[]}
 */
const RUN_DIR_NAMES = [RUN_DIR_NAME, ".postmortem", ".logs", ".dry-run"];

/**
 * The `.gitignore` the run writes into its own container.
 *
 * Written by the pipeline rather than by editing the repository's ignore file, because the
 * container lives in WHATEVER repository the series happens to be in — and the rule has to
 * travel with the folder. A machine that pulls the series gets the rule with it.
 *
 * The point of the file is the split: the records are the thing you commit so another
 * machine can continue this run, and the transcripts are not. `logs/` is gigabytes of model
 * chatter and `dry-run/` is a rehearsal dump; `run.lock` names a process on one machine, and
 * a lock file that is checked in is a lie about who is running.
 */
const RUN_STATE_GITIGNORE = [
  "# Written by ai-client when it created this folder. Edit it if you want.",
  "# Everything here that is NOT listed below is the run's memory, and it is meant to be",
  "# committed: the post-mortem reports, the ledger, the tickets, the patch records, the",
  "# delivery plan. Another machine that pulls this folder can continue the run.",
  "",
  "# The transcripts: every prompt and answer of every model call. Diagnostic, huge, and",
  "# specific to the machine that made them.",
  `${RUN_STATE_SUBDIRS.logs}/`,
  "",
  "# --dry-run prompt dumps: what the run would have sent, written by a run that sent nothing.",
  `${RUN_STATE_SUBDIRS.dryRun}/`,
  "",
  "# A lock names a process. Checked in, it claims a run is in progress on a machine that",
  "# has no such process.",
  `${RUN_STATE_SUBDIRS.postmortem}/run.lock`,
  "",
].join("\n");

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * An explicitly configured folder, or null when the setting is unset.
 *
 * Whitespace counts as unset: `RUN_DIR=` in a `.env` is somebody saying "I did not decide",
 * not somebody deciding on a folder.
 *
 * @param {string} name - The environment variable to read.
 * @returns {string|null} Absolute path, or null.
 */
function configuredDir(name) {
  const raw = (process.env[name] || "").trim();
  return raw ? path.resolve(raw) : null;
}

/**
 * The series folder this process is working on, or null when nobody told it.
 *
 * Read at CALL time, not at require time: the memory folders are resolved by modules that
 * are required long before a task starts (the logger is one of them), and a constant frozen
 * at require time is how gotcha 79 happened.
 *
 * @returns {string|null} Absolute path, or null.
 */
function runStateSeriesDir() {
  const raw = (process.env.SERIES_LOCATION || "").trim();
  return raw ? path.resolve(raw) : null;
}

/**
 * The container folder this run keeps its records in.
 *
 * `RUN_DIR` wins outright. Otherwise it is `<series>/.run`, so the memory follows the series
 * and two series never share a ledger. The repo folder is the LAST fallback, used only when
 * no series was chosen at all — and it is a fallback worth noticing, because a run with no
 * chosen series has no memory worth keeping either.
 *
 * @returns {string} Absolute path to the run's container folder.
 */
function runHomeDir() {
  const explicit = configuredDir("RUN_DIR");
  if (explicit) return explicit;
  const series = runStateSeriesDir();
  if (series) return path.join(series, RUN_DIR_NAME);
  return path.join(projectRoot, RUN_DIR_NAME);
}

/**
 * Where the step reports, the ledger, the tickets, the patch records, the delivery plan and
 * the run lock live (`POSTMORTEM_DIR`, default `<run home>/postmortem`).
 *
 * This is the one function the whole delivery layer resolves through: utils/ledger,
 * utils/tickets, utils/patches and utils/runlock each ask it where their own files are, so
 * moving the memory is one change and not four. → AGENTS.md gotcha 80.
 *
 * @returns {string} Absolute path.
 */
function postMortemDir() {
  return configuredDir("POSTMORTEM_DIR") || path.join(runHomeDir(), RUN_STATE_SUBDIRS.postmortem);
}

/**
 * Where the per-process transcripts of every model call are written (`LOGS_DIR`, default
 * `<run home>/logs`). Resolved lazily by the logger, which is required before any task has
 * started.
 *
 * @returns {string} Absolute path.
 */
function logsDir() {
  return configuredDir("LOGS_DIR") || path.join(runHomeDir(), RUN_STATE_SUBDIRS.logs);
}

/**
 * Where `--dry-run` writes the prompts it would have sent (`DRY_RUN_DIR`, default
 * `<run home>/dry-run`).
 *
 * @returns {string} Absolute path.
 */
function dryRunDir() {
  return configuredDir("DRY_RUN_DIR") || path.join(runHomeDir(), RUN_STATE_SUBDIRS.dryRun);
}

// ─── Recognition ──────────────────────────────────────────────────────────────

/**
 * Whether a folder NAME in a series root belongs to the run rather than to the series.
 *
 * @param {string} name - A directory name as a readdir reported it.
 * @returns {boolean}
 */
function isRunStateFolderName(name) {
  return RUN_DIR_NAMES.includes(name);
}

/**
 * Whether a path is inside this run's own records.
 *
 * Used by the patch channel: the working-tree fingerprint must not read the run's own
 * bookkeeping as "an undeclared change", because writing a ticket is what the machinery does
 * on its own way to a decision. It is not a hole in the guard — a patch that NAMES one of
 * these files is refused by `BANNED_PATCH_PATHS` (`edit-machine-state`) before it ever gets
 * as far as a fingerprint.
 *
 * @param {string} target - Absolute or project-relative path.
 * @param {string} [root] - The project root a relative path means relative to.
 * @returns {boolean}
 */
function isRunStatePath(target, root = projectRoot) {
  const home = path.resolve(runHomeDir());
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, String(target || ""));
  const rel = path.relative(home, abs);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ─── The folder's own ignore rule ─────────────────────────────────────────────

/**
 * Write the container's `.gitignore`, once.
 *
 * Never overwrites: an operator who edited the rule is making a decision about their own
 * repository, and a pipeline that rewrites it on the next run is the pipeline editing their
 * config. Absent means write; present means leave it alone.
 *
 * Synchronous on purpose: the logger calls it while creating the folder it is about to fill,
 * and an ignore rule that lands a tick after the transcripts it is supposed to exclude is a
 * rule that missed.
 *
 * @param {string} [home] - The container folder. Defaults to runHomeDir().
 * @returns {{written: boolean, file: string, error: string|null}}
 */
function ensureRunStateGitignore(home = runHomeDir()) {
  const file = path.join(home, ".gitignore");
  try {
    if (fs.existsSync(file)) return { written: false, file, error: null };
  } catch {
    /* fall through and try to write it */
  }
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, RUN_STATE_GITIGNORE, "utf8");
    return { written: true, file, error: null };
  } catch (err) {
    // A folder that cannot be written is a run that cannot keep its records, and that is the
    // run's problem to hear about — not this helper's to turn into a crash.
    return { written: false, file, error: String(err.message || err) };
  }
}

// ─── The memory that did not move ─────────────────────────────────────────────

/**
 * The records a run left in the repo folder BEFORE this moved, if any are still there.
 *
 * Moving the memory out of the repo is a one-way change for anyone mid-series: their ledger,
 * tickets and patch records are sitting in `<repo>/.postmortem`, and the new default does not
 * look there. Silently starting a fresh ledger is the quiet version of losing a run's memory
 * — the anti-spin gate would report "first attempt" for an attempt already spent — so it is
 * reported instead, once per process, with the exact command that finishes the move.
 *
 * Read-only by construction: it never moves or deletes anything, because a scan for a stale
 * folder is also something a test does, and a check that relocates a run's records as a side
 * effect of being asked where they are is not a check.
 *
 * @returns {{dir: string, files: string[]}|null} The legacy folder and what is in it, or null.
 */
function legacyPostMortemRecords() {
  const dir = path.join(projectRoot, ".postmortem");
  const current = postMortemDir();
  if (path.resolve(dir) === current) return null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  return { dir, files: names };
}

/** One announcement per process, so a nine-step run does not repeat itself nine times. */
let legacyAnnounced = false;

/**
 * Say out loud, once, that a run's old memory is sitting where the new default no longer reads.
 * @returns {void}
 */
function announceLegacyRunState() {
  if (legacyAnnounced) return;
  legacyAnnounced = true;
  const legacy = legacyPostMortemRecords();
  if (!legacy) return;
  console.error(
    `[run-state] this repo still holds ${legacy.files.length} record(s) in ${legacy.dir} from before ` +
      `the run's records moved next to the series.\n` +
      `          The run is now reading ${postMortemDir()} instead, so that history is invisible to it:\n` +
      `          the anti-spin ledger and the resume triage will treat this as a run that has tried nothing.\n` +
      `          Move it with:  mv ${legacy.dir} ${path.join(runHomeDir(), RUN_STATE_SUBDIRS.postmortem)}`
  );
}

announceLegacyRunState();

module.exports = {
  RUN_DIR_NAME,
  RUN_DIR_NAMES,
  RUN_STATE_SUBDIRS,
  RUN_STATE_GITIGNORE,
  configuredDir,
  runStateSeriesDir,
  runHomeDir,
  postMortemDir,
  logsDir,
  dryRunDir,
  isRunStateFolderName,
  isRunStatePath,
  ensureRunStateGitignore,
  legacyPostMortemRecords,
};
