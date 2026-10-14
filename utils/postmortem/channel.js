/**
 * utils/postmortem/channel.js — what a step learned WHILE it was running, put on the disk.
 *
 * The post-mortem assesses a finished step **from the disk** (`run.js` → `volume.js` / `file.js` /
 * `scope.js`). That is the right way to ask "did this step leave what it owes", and it is cheap, and it
 * runs in a different process from the step. But a fact a stage discovered inside its own process — a
 * term-list read that never produced a list, a chapter whose answer never closed — is not on the disk in
 * any shape the assessment looks at. It was on the console, and in the report the grader reads, and on a
 * field of the stage's own context object that nothing read. So it never reached the triage, never reached
 * the volume-halt gate, and a MAJOR finding behaved like a sentence. That is gotcha 138, and the live
 * measurement behind it: run `2026-10-13T12-45-22-158Z` paid 73,330 tokens for volume 01 chapter 5, filed
 * 0 terms, and the run's ledger recorded 0 HIGH / 0 MEDIUM / 0 LOW for that step.
 *
 * This is the missing pipe. A step calls `utils/series-run/findings.js` at the end of its work on one
 * volume; the record lands in the run's own records folder; `runPostMortem` reads it back while assessing
 * that volume, so the finding is a finding — routed by its level (`utils/resume/state.js`), able to halt
 * the walk (`utils/postmortem/halt.js`), recorded in the ledger, and visible in the report a human reads.
 *
 * Four rules keep it from becoming a way for a step to grade itself:
 *
 *   1. **The level is never the caller's.** The record stores severity, kind, file and message. The level
 *      is looked up from `./levels.js` at READ time, through `finding()` in `./rules.js` — the same
 *      constructor every disk finding goes through. A step that sends `level: "STOP"` gets the level the
 *      table declares, and a kind the table does not know arrives at MINOR **and says so in its own
 *      message**, exactly as a disk finding does. The table lives in a banned patch path; this file cannot
 *      add a row to it and does not try.
 *   2. **Absence is named, not punished.** No record for a volume is not a finding. Every volume already
 *     on disk, and every `--dry-run`, is in that class, and the assessment says so in its own markdown
 *     rather than inventing damage for a book it never processed.
 *   3. **A record that does not describe this book is stale.** The record carries the source file it was
 *      written against and the sha256 of that file — the same recorded fact the idempotency skip-check uses
 *      (`utils/series-run/skip.js` → `isSourceStale`). The assessment re-reads that file and re-hashes it.
 *      Different content, or the file is gone, or the record carries no identity at all → the record is
 *      named stale and its findings are **not** counted. No timestamp is compared anywhere: gotcha 114 is
 *      the precedent for comparing recorded history rather than a stamp, and a stamp would make every
 *      re-run of a healthy volume look out of date.
 *   4. **It is not a switch.** There is no environment variable in this file and there must not be one, and
 *      a step that does not use the channel simply has no record — which rule 2 treats as silence, not as
 *      compliance.
 *
 * What it deliberately does NOT do: carry a stage's *opinions*. It carries findings a stage built with the
 * post-mortem's own constructor, in the post-mortem's own vocabulary. A stage that wants to report
 * something new needs a new kind, and a new kind is a row in `./levels.js` — which is the account owner's
 * decision, not this file's (AGENTS.md rule 3).
 *
 * This file requires `./rules` (the finding constructor), `./scope` (the one volume-key naming rule) and
 * nothing else in the repository. It requires nothing from `utils/ledger`, `utils/tickets`, `utils/patches`,
 * `utils/runlock` or `utils/delivery-verify` — a module under `utils/postmortem/` that reached back for
 * them would close a require cycle (gotcha 85).
 *
 * @module utils/postmortem/channel
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { finding, undeclaredLevelNote } = require("./rules");
const { runScopeVolumeKey } = require("./scope");

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */
/** @typedef {import("../types").TranslationTargetVolume} TranslationTargetVolume */

/**
 * One thing a step reported about one volume, as it is stored.
 *
 * Deliberately smaller than a `PostMortemFinding`: no `level`, no `levelDeclared`, no `step`, no `volume`.
 * Those four are decided by the reader, from the table and from the record's own address, so a caller
 * cannot supply any of them.
 *
 * @typedef {Object} ChannelFindingRecord
 * @property {"HIGH"|"MEDIUM"|"LOW"} severity - The severity the step's own check produced.
 * @property {string} kind - The finding kind, which is what the level table is looked up by.
 * @property {string} file - The file the finding names, in the same shape a disk finding carries it.
 * @property {string} message - What the step found, in its own words.
 */

/**
 * What one step reported about one volume.
 *
 * @typedef {Object} ChannelRecord
 * @property {number} schema - Record schema version.
 * @property {string} step - The step that wrote it. The record is honoured only for this step.
 * @property {string} volume - The installment number, exactly as the plan of record spells it.
 * @property {string} folder - The volume folder name, so a human can find the book.
 * @property {{sourceFile: string, sourceFingerprint: string}} identity
 *   The book this record was written for: the source file's name inside the volume folder, and its sha256.
 *   Compared against the file on disk at read time. Never compared against a clock.
 * @property {ChannelFindingRecord[]} findings - What the step found, or an empty list when it found nothing.
 * @property {string} reportedAt - ISO timestamp, for a human reading the file. NEVER compared by anything.
 */

/**
 * The outcome of asking the channel about one volume.
 *
 * @typedef {Object} ChannelRead
 * @property {string} volume - The installment number that was asked about.
 * @property {boolean} present - False when the step wrote nothing for this volume (or the record cannot be
 *   read). Absence is not a finding.
 * @property {string|null} stale - Set when a record IS present but does not describe the book being
 *   assessed; its text is the reason. Its findings are not counted.
 * @property {PostMortemFinding[]} findings - The findings counted for this volume, levels already looked
 *   up from the table.
 * @property {string[]} refused - Findings the record held that this layer would not accept (a missing kind,
 *   a severity the ladder does not have). Named, never silently dropped.
 */

// ─── Where the records live ───────────────────────────────────────────────────

/** The subfolder of the run's records folder the channel writes into. */
const CHANNEL_DIR_NAME = "step-findings";

/** The record's schema version. Bump it when the shape changes, and keep reading the old one. */
const CHANNEL_RECORD_SCHEMA = 1;

/** The severities the finding ladder has. Anything else is refused rather than guessed at. */
const CHANNEL_SEVERITIES = new Set(["HIGH", "MEDIUM", "LOW"]);

/**
 * The folder one run's channel records sit in.
 *
 * `runDir` is `postMortemDir()`, resolved by the CALLER at call time — a machine-state path frozen at
 * require time is gotcha 79, and one built from this file's own `__dirname` is gotcha 80.
 *
 * @param {string} runDir - Absolute path to the run's records folder.
 * @returns {string}
 */
function channelDir(runDir) {
  return path.join(String(runDir || ""), CHANNEL_DIR_NAME);
}

/**
 * The file one (step, volume) pair's record lives in.
 *
 * The volume key is `runScopeVolumeKey` — the same rule `extract`'s per-book reports and the run-scope
 * assessment use, because two implementations of one naming rule is the pair that drifts (gotcha 127).
 *
 * @param {{ runDir: string, step: string, volume: string }} opts
 * @returns {string} Absolute path.
 */
function channelRecordPath({ runDir, step, volume }) {
  return path.join(channelDir(runDir), `${String(step)}-${runScopeVolumeKey({ installmentNumber: volume })}.json`);
}

/**
 * sha256 of a file, the same digest `utils/source`'s `sha256OfFile` produces and the same one the
 * idempotency skip-check compares.
 *
 * Written here rather than imported: `utils/source`'s barrel reaches into the converters (and one of its
 * submodules reaches back into `utils/postmortem/rules`), and a leaf of the post-mortem layer pulling that
 * in to compute one hash is how a require cycle gets started (gotcha 85). `test/test-finding-channel.js`
 * pins the two digests against each other so they cannot drift.
 *
 * @param {string} filePath
 * @returns {string|null} The hex digest, or null when the file cannot be read.
 */
function sha256Of(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

// ─── Writing ──────────────────────────────────────────────────────────────────

/**
 * One finding as the caller handed it, narrowed to the four fields the channel is allowed to keep.
 *
 * @param {PostMortemFinding|ChannelFindingRecord} f
 * @returns {{kept: ChannelFindingRecord|null, refused: string|null}}
 */
function narrowFinding(f) {
  if (!f || typeof f !== "object") return { kept: null, refused: "a finding that is not an object" };
  const kind = String(f.kind || "").trim();
  if (!kind) return { kept: null, refused: "a finding with no kind" };
  const severity = String(f.severity || "").trim().toUpperCase();
  if (!CHANNEL_SEVERITIES.has(severity)) {
    return { kept: null, refused: `${kind}: severity "${f.severity}" is not on the ladder (HIGH/MEDIUM/LOW)` };
  }
  return {
    kept: {
      severity,
      kind,
      file: String(f.file || ""),
      message: String(f.message || ""),
    },
    refused: null,
  };
}

/**
 * Record what one step found about one volume, into the run's own records.
 *
 * One file per (step, volume), replaced whole on every write: the channel holds what the step's most
 * recent pass over that volume learned, not a transcript of every pass. A volume the step did NOT process
 * writes nothing, so the earlier record stands and the hole stays visible across runs.
 *
 * @param {Object} opts
 * @param {string} opts.runDir - The run's records folder (`postMortemDir()`, resolved at call time).
 * @param {string} opts.step - The step reporting. It must be the gulp task name `utils/artifacts.js` uses.
 * @param {string} opts.volume - The installment number.
 * @param {string} opts.folder - The volume folder name.
 * @param {{sourceFile: string, sourceFingerprint: string}} opts.identity - The book this record describes.
 * @param {Array<PostMortemFinding|ChannelFindingRecord>} opts.findings - What the step found. May be empty.
 * @returns {{written: boolean, file: string, count: number, refused: string[], error: string|null}}
 */
function writeChannelRecord({ runDir, step, volume, folder, identity, findings }) {
  const file = channelRecordPath({ runDir, step, volume });
  const kept = [];
  /** @type {string[]} */
  const refused = [];
  for (const f of findings || []) {
    const read = narrowFinding(f);
    if (read.kept) kept.push(read.kept);
    else refused.push(read.refused);
  }

  const sourceFile = String((identity && identity.sourceFile) || "").trim();
  const sourceFingerprint = String((identity && identity.sourceFingerprint) || "").trim();
  if (!sourceFile || !sourceFingerprint) {
    // A record with no identity can never pass the staleness check, so writing it would guarantee a
    // "stale" line on the next assessment and bury the finding it was carrying. Refuse, and say why.
    return {
      written: false,
      file,
      count: 0,
      refused,
      error: "the channel needs the source file it read and its sha256; a record without an identity is unreadable by rule",
    };
  }

  /** @type {ChannelRecord} */
  const record = {
    schema: CHANNEL_RECORD_SCHEMA,
    step: String(step),
    volume: String(volume),
    folder: String(folder || ""),
    identity: { sourceFile, sourceFingerprint },
    findings: kept,
    reportedAt: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    return { written: true, file, count: kept.length, refused, error: null };
  } catch (err) {
    // A channel that cannot write is a step whose finding stays where it always was: in its own process.
    // That is the hole this file exists to close, so it is reported, and it is not a crash.
    return { written: false, file, count: 0, refused, error: String(err.message || err) };
  }
}

// ─── Reading ──────────────────────────────────────────────────────────────────

/**
 * The raw record for one (step, volume), or null when there is none or it cannot be read.
 *
 * @param {{ runDir: string, step: string, volume: string }} opts
 * @returns {ChannelRecord|null}
 */
function readChannelRecord({ runDir, step, volume }) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(channelRecordPath({ runDir, step, volume }), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.findings)) return null;
  return parsed;
}

/**
 * Rebuild one stored finding as a real finding, with the level taken from the table.
 *
 * `finding()` is the same constructor every disk finding goes through, so the level, the
 * `levelDeclared` flag and the "this level was defaulted" note are produced by one piece of code for both
 * halves of the layer. The note is stripped from the stored message first, because the message the step
 * handed over was already built by `finding()` — re-decorating it without stripping would print the same
 * sentence twice.
 *
 * @param {ChannelFindingRecord} stored
 * @param {string} step
 * @param {string} volume
 * @returns {PostMortemFinding}
 */
function rebuildFinding(stored, step, volume) {
  const kind = String(stored.kind || "");
  const note = undeclaredLevelNote(kind);
  const raw = String(stored.message || "");
  const message = raw.endsWith(note) ? raw.slice(0, raw.length - note.length).trimEnd() : raw;
  return finding(stored.severity, kind, step, volume, String(stored.file || ""), message);
}

/**
 * Ask the channel what this step said about this volume, and turn the answer into findings.
 *
 * The staleness rule is a content comparison against the book on disk: the record names the source file it
 * read and carries its sha256; this re-reads that file and re-hashes it. A record whose identity does not
 * match the folder being assessed is named and its findings are dropped — a finding about a different
 * book must not pause a run over this one.
 *
 * @param {Object} opts
 * @param {string} opts.runDir - The run's records folder.
 * @param {string} opts.step - The step being assessed.
 * @param {string} opts.seriesDir - The series folder the volume lives in.
 * @param {TranslationTargetVolume} opts.volumeEntry - The volume being assessed.
 * @returns {Promise<ChannelRead>}
 */
async function readVolumeChannel({ runDir, step, seriesDir, volumeEntry }) {
  const volume = volumeEntry && volumeEntry.installmentNumber;
  /** @type {ChannelRead} */
  const silent = { volume, present: false, stale: null, findings: [], refused: [] };
  const record = readChannelRecord({ runDir, step, volume });
  if (!record) return silent;

  if (String(record.step) !== String(step) || String(record.volume) !== String(volume)) {
    return {
      volume,
      present: true,
      stale: `the record at ${path.basename(channelRecordPath({ runDir, step, volume }))} names step "${record.step}" volume "${record.volume}", not this one`,
      findings: [],
      refused: [],
    };
  }

  const identity = record.identity && typeof record.identity === "object" ? record.identity : null;
  const sourceFile = String((identity && identity.sourceFile) || "").trim();
  const storedHash = String((identity && identity.sourceFingerprint) || "").trim();
  if (!sourceFile || !storedHash) {
    return {
      volume,
      present: true,
      stale: "the record carries no source file and sha256, so nothing can tell whether it describes this book",
      findings: [],
      refused: [],
    };
  }

  const onDisk = path.join(seriesDir, volumeEntry.folder, sourceFile);
  const nowHash = sha256Of(onDisk);
  if (nowHash === null) {
    return {
      volume,
      present: true,
      stale: `the book this record was written against (${volumeEntry.folder}/${sourceFile}) is no longer in the volume folder`,
      findings: [],
      refused: [],
    };
  }
  if (nowHash !== storedHash) {
    return {
      volume,
      present: true,
      stale: `this record was written against ${volumeEntry.folder}/${sourceFile} (${storedHash.slice(0, 12)}…), which is not the book there now (${nowHash.slice(0, 12)}…)`,
      findings: [],
      refused: [],
    };
  }

  /** @type {PostMortemFinding[]} */
  const findings = [];
  /** @type {string[]} */
  const refused = [];
  for (const stored of record.findings) {
    const narrowed = narrowFinding(stored);
    if (!narrowed.kept) {
      refused.push(narrowed.refused);
      continue;
    }
    findings.push(rebuildFinding(narrowed.kept, String(step), String(volume)));
  }
  return { volume, present: true, stale: null, findings, refused };
}

/**
 * What the channel said about one assessment: the per-volume reads folded into one line.
 *
 * @typedef {Object} ChannelSummary
 * @property {number} volumes - Volumes this assessment asked the channel about.
 * @property {number} reported - Volumes that had a record and that record described this book.
 * @property {number} silent - Volumes with no record. Not damage, and not a finding: every volume already
 *   on disk and every `--dry-run` is in this class.
 * @property {Array<{volume: string, reason: string}>} stale - Records that exist but do not describe the
 *   book being assessed. Named, and their findings are not counted.
 * @property {number} findings - Findings the channel contributed to this report.
 * @property {string[]} silentVolumes - The silent volumes, by installment number, so the report can name them.
 * @property {string[]} refused - Findings a record held that this layer would not accept. Named, never dropped.
 */

/**
 * Fold the per-volume channel reads into the one line the report carries.
 *
 * @param {ChannelRead[]} reads - One entry per volume this assessment looked at.
 * @returns {ChannelSummary}
 */
function summarizeChannelReads(reads) {
  const list = reads || [];
  const silentVolumes = [];
  /** @type {Array<{volume: string, reason: string}>} */
  const stale = [];
  /** @type {string[]} */
  const refused = [];
  let reported = 0;
  let findings = 0;
  for (const read of list) {
    if (!read.present) silentVolumes.push(String(read.volume));
    else reported++;
    if (read.stale) stale.push({ volume: String(read.volume), reason: read.stale });
    if (read.refused && read.refused.length) refused.push(...read.refused);
    findings += read.findings.length;
  }
  return {
    volumes: list.length,
    reported,
    silent: silentVolumes.length,
    stale,
    findings,
    silentVolumes,
    refused,
  };
}

module.exports = {
  CHANNEL_DIR_NAME,
  CHANNEL_RECORD_SCHEMA,
  channelDir,
  channelRecordPath,
  sha256Of,
  writeChannelRecord,
  readChannelRecord,
  readVolumeChannel,
  summarizeChannelReads,
};
