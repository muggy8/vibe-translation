/**
 * utils/reference-store/db.js — the one place in this repository that touches the
 * storage engine.
 *
 * Doc 03 §1 decides the engine (`node:sqlite`, built in, no new dependency) and the
 * mitigation for it being experimental: **wrap it behind one module so the engine is
 * swappable**. That mitigation only works if it is the only door, so this file is the
 * only file under `utils/reference-store/` that calls `require("node:sqlite")`, and the
 * only file anywhere that runs `PRAGMA`s. Everything above it talks to a handle.
 *
 * What this file owns:
 *   - opening a database file with the pragmas the design requires (WAL, foreign keys,
 *     a busy timeout), creating the folder it lives in;
 *   - the engine's one sharp edge on this machine: `node:sqlite` prints an
 *     `ExperimentalWarning` on every load (doc 03 §2.1.1 leaves it as an open question).
 *     See `silenceSqliteExperimentalWarning` for what was decided and why;
 *   - `copyDatabase`, the engine-specific half of copy-forward (slice 3). It does **not** use
 *     the engine's own online-backup call: measured on this machine, `sqlite.backup()`
 *     produced an EMPTY destination whenever the source had a live write-ahead log — which is
 *     exactly the state a real copy runs in, because the source store is open when the copy is
 *     made — and after a checkpoint the same call reported `database is locked`. What it does
 *     instead is `PRAGMA wal_checkpoint(TRUNCATE)` on the source, then `fs.copyFileSync`, then
 *     delete the destination's `-wal`/`-shm` sidecars so the copy starts from the database
 *     alone. Gotcha 95. `test/test-reference-store-copy.js` asserts the copy is a readable
 *     store carrying the source's rows, which is the assertion that fails if anyone
 *     "simplifies" this back to `backup()`.
 *
 * @module utils/reference-store/db
 */

const fs = require("fs");
const path = require("path");

require("../../types"); // JSDoc type definitions

// ─── The ExperimentalWarning ──────────────────────────────────────────────────

/** True once this process has installed the filter. Installing it twice stacks. */
let warningFilterInstalled = false;

/**
 * Stop `node:sqlite`'s load-time `ExperimentalWarning` from printing, and nothing else.
 *
 * Doc 03 §2.1.1 asks this question and leaves it open. The decision here is: **filter
 * this one warning, in this one file, and forward every other warning to Node's own
 * handler** — rather than let it print once per process across `npm test`.
 *
 * Why filtered rather than accepted: the warning is a statement about the engine, and
 * the design's answer to it is already written down (risk 9.1 of doc 03: the engine is
 * experimental, the mitigation is this wrapper). Printing it again on every test run
 * teaches the reader nothing and buries the lines that do. It is also not a silent
 * swallow: the fact that the engine is experimental is recorded IN the store itself
 * (`store_info.engine`, written by `applySchema`) and reported by `engineInfo()`, so the
 * information lands where a reader of a volume's record will actually meet it.
 *
 * Why the filter is narrow, and why it is written the way it is: Node prints a warning
 * through a listener that is installed at bootstrap, and `process.emitWarning` defers the
 * emit to `process.nextTick` — so a listener added and removed around the `require` is
 * already gone by the time the warning arrives (that was the first attempt here, and it
 * printed anyway). The filter therefore has to stay installed for the life of the
 * process, which is exactly the kind of global hook this repository is careful about. So
 * it is pinned in a test (`test/test-reference-store.js`): the SQLite warning is
 * swallowed, a different warning still reaches stderr through Node's own handler, and
 * installing the filter twice does not stack a second copy.
 *
 * @returns {void}
 */
function silenceSqliteExperimentalWarning() {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;

  const nodeDefaults = process.listeners("warning");
  for (const listener of nodeDefaults) process.removeListener("warning", listener);

  process.on("warning", function sqliteWarningFilter(warning) {
    if (
      warning &&
      warning.name === "ExperimentalWarning" &&
      /SQLite is an experimental feature/.test(String(warning.message || ""))
    ) {
      return;
    }
    for (const listener of nodeDefaults) listener.call(process, warning);
  });
}

// ─── The engine ───────────────────────────────────────────────────────────────

/** The loaded engine module, loaded once per process. */
let engineModule = null;

/**
 * Load `node:sqlite` (once), with the load-time warning filtered.
 *
 * @returns {{DatabaseSync: Function, backup: Function}} The engine.
 */
function engine() {
  if (!engineModule) {
    silenceSqliteExperimentalWarning();
    engineModule = require("node:sqlite");
  }
  return engineModule;
}

/**
 * What engine this store is on, for the record rather than for the console.
 *
 * @returns {{name: string, experimental: boolean, note: string}}
 */
function engineInfo() {
  return {
    name: "node:sqlite",
    experimental: true,
    note:
      "node:sqlite is experimental on this Node (doc 03 §9.1). The mitigation is this " +
      "module: nothing outside utils/reference-store/db.js writes SQL, so the engine is " +
      "swappable without touching the schema, the queries, or the guards.",
  };
}

/**
 * Open one volume's reference database.
 *
 * The pragmas are the design's, not a preference (doc 03 §2): WAL because a read must
 * never block the writer, foreign keys because the ownership and evidence rules are
 * partly enforced by the schema, and a busy timeout because a second process opening the
 * same file is a real setup even though `STAGE_CONCURRENCY` defaults to 1.
 *
 * Creates the folder when `readOnly` is false. A database file is written next to the
 * book it describes, and the folder is the volume folder — so a missing folder is a
 * missing volume, which `paths.js` has already refused before this is reached.
 *
 * @param {string} file - Absolute path to the `.db` file.
 * @param {{readOnly?: boolean}} [opts]
 * @returns {Object} An open `DatabaseSync` handle.
 */
function openDatabase(file, { readOnly = false } = {}) {
  const { DatabaseSync } = engine();
  if (!readOnly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, {
    open: true,
    readOnly,
    enableForeignKeyConstraints: true,
  });
  db.exec("PRAGMA foreign_keys = ON;");
  if (!readOnly) db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Copy one open database to a new file: checkpoint, then copy.
 *
 * **Why not the engine's own `backup()`, which this file originally used:** measured on
 * this machine (Node 22.22.1), `backup()` of a source with a live write-ahead log produced
 * an **empty** destination — the schema and rows were simply not there — and after a
 * `wal_checkpoint(TRUNCATE)` it left the destination reporting `database is locked` to the
 * next opener. Both shapes were reproduced twice before this was changed. A copy that
 * silently loses every row is precisely the failure copy-forward exists to catch (doc 03
 * §7.3), so the step cannot rest on an API that does that.
 *
 * What is used instead is the boring, inspectable version: checkpoint the source's WAL into
 * its main file and truncate it, so the main file alone is the whole database; copy that
 * file; drop any WAL sidecars the destination might otherwise inherit. The source handle is
 * not written to after the checkpoint, so nothing can re-fill the WAL behind the copy.
 *
 * @param {Object} sourceDb - An open handle to the database being copied.
 * @param {string} sourceFile - Its file.
 * @param {string} destFile - Absolute path to write.
 * @returns {{ok: boolean, error: string|null}}
 */
function copyDatabase(sourceDb, sourceFile, destFile) {
  try {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    sourceDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    fs.copyFileSync(sourceFile, destFile);
    for (const suffix of ["-wal", "-shm"]) fs.rmSync(destFile + suffix, { force: true });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Remove a half-written destination database, so a failed copy does not leave a file that
 * looks like a volume's record.
 *
 * Deletes the file and its WAL sidecars. This is not a capability the agent layer has —
 * the file sandbox has no `deleteFile` at all (gotcha 8) — it is the store cleaning up a
 * file IT created seconds ago, in a step that already refused.
 *
 * @param {string} file - Absolute path.
 * @returns {void}
 */
function discardDatabase(file) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + suffix, { force: true });
    } catch {
      /* a sidecar that is not there is not a problem */
    }
  }
}

module.exports = {
  engine,
  engineInfo,
  openDatabase,
  copyDatabase,
  discardDatabase,
  silenceSqliteExperimentalWarning,
};
