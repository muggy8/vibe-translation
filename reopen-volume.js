#!/usr/bin/env node
/**
 * reopen-volume.js — the door onto redoing a volume whose record is already published.
 *
 * Why this is a command and not a flag. Every volume after the first is built on the volume before it:
 * volume 2's record is a copy of volume 1's, stamped with the hash of the file it was copied from. So
 * "run volume 1 again" is not a local edit — it invalidates every copy made from it. The guards that
 * stop that (`rebuild-refuses-a-sealed-voice-record`, the sealed-volume refusals in `extract-voice.js`
 * and `rebuild-voice.js`) are guards this project paid for in blood, and a `--no-seal` flag would switch
 * them off. This command does not switch anything off. It changes the state the guards are asked about,
 * by an act that **requires a reason**, writes that reason into the record itself (`record_reopens`),
 * and prints it in the audit report whoever reads it later.
 *
 * What the act physically is: **retire the record, then re-derive it.** The volume's `series.db` is moved
 * aside whole — every sealed row in it stays sealed, in a file that is still readable — and the next run
 * builds the volume's record from the beginning: copied forward from the volume before it, topped up with
 * its own published glossary, re-read from its own chapters. Nothing is unsealed. No sealed row is edited.
 *
 * The cascade, said out loud rather than guessed at:
 *
 *   - Reopening a volume that other records were copied from **refuses** and names them, because the
 *     top-up door only ever ADDS rows: topping up a stale record would pour the new volume 1's claims
 *     into a file that still holds the old volume 1's claims and report success.
 *   - `--cascade=retire` is the answer it accepts: those records are retired too, with the same reason
 *     recorded.
 *   - After that, `openVolumeRecord` refuses any record whose source volume was reopened after the copy
 *     was made (`record-copy-is-stale`), so a stale copy cannot pass silently even if this command was
 *     never run again.
 *
 * What this command does NOT do: it does not touch `character-voice.md`, `pov-map.md` or `glossary.md`.
 * Those are moved aside by the door that replaces them, when it replaces them (see the numbered
 * `.rejected` files). A redo that deleted the artifacts before re-reading the book would destroy the
 * evidence before producing the replacement.
 *
 * Usage:
 *   node reopen-volume.js --volume=01 --reason="the extraction pass that built this record swallowed parse errors"
 *   node reopen-volume.js --volume=01 --reason="…" --cascade=retire
 *   node reopen-volume.js --list
 *
 * Flags:
 *   --volume=NN        required (except with --list)
 *   --reason="…"       required, and required to be a reason rather than the act restated
 *   --cascade=retire   retire the records copied from this volume too. Without it, their existence is a
 *                      refusal. There is no third value and no environment variable supplies one.
 *   --series=<dir>     the folder holding the volume folders (default SERIES_LOCATION)
 *   --history          print this volume's reopen history from its record and stop
 *   --list             print which folder a --volume would name, and stop
 *
 * Exit codes: 0 the record was retired and the fresh one is in place, 1 refused.
 *
 * @module reopen-volume
 */

const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { openSeriesRun } = require("./utils/series-run");
const rs = require("./utils/reference-store");
require("./types"); // JSDoc type definitions

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, reason: string|null, cascade: string, series: string|null, list: boolean, history: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { volume: null, reason: null, cascade: "refuse", series: null, list: false, history: false, error: null };
  for (const arg of argv) {
    if (arg === "--list") out.list = true;
    else if (arg === "--history") out.history = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--reason=")) out.reason = arg.slice("--reason=".length);
    else if (arg.startsWith("--cascade=")) out.cascade = arg.slice("--cascade=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else out.error = `unrecognised flag: ${arg}`;
  }
  return out;
}

/**
 * Print one refusal the way this command prints all of them.
 *
 * @param {Object} refusal
 * @param {(line: string) => void} log
 * @returns {void}
 */
function printRefusal(refusal, log) {
  log(`\nREFUSED — ${refusal.rule}`);
  log(`  ${refusal.because}`);
  if (Array.isArray(refusal.useInstead) && refusal.useInstead.length) {
    log("  instead:");
    for (const line of refusal.useInstead) log(`    - ${line}`);
  }
  if (refusal.fix) log(`  fix: ${refusal.fix}`);
}

/**
 * The command's body.
 *
 * @param {Object} opts
 * @param {Object} opts.args - From `readArgs`.
 * @param {string} opts.seriesDir
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<number>} The process exit code.
 */
async function main({ args, seriesDir, log = console.log }) {
  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun: true, volumeArg: args.volume });

  if (args.list) {
    log(`reopen-volume — ${runSettings.seriesDir}`);
    for (const folder of volumes) {
      const entry = volumeByFolder.get(folder);
      log(`  volume ${String(entry.installmentNumber).padStart(2, "0")}  ${folder}`);
    }
    return 0;
  }

  if (volumes.length !== 1) {
    log(`REFUSED — one-volume-only`);
    log(`  this command reopens one volume per invocation; --volume=${args.volume || "<NN>"} selected ${volumes.length}.`);
    log(`  fix: pass exactly one volume, e.g. --volume=01`);
    return 1;
  }

  const folderName = volumes[0];
  const entry = volumeByFolder.get(folderName);
  const volume = entry.installmentNumber;

  if (args.history) {
    const opened = rs.openReferenceStore({ volume, folder: folderName, seriesDir, stage: rs.DOCUMENT_SOURCE_STAGE, create: false });
    const history = rs.readReopenHistory(opened);
    opened.close();
    log(`reopen history — volume ${volume} (${folderName})`);
    if (!history.length) {
      log("  none. This record has never been reopened.");
      return 0;
    }
    for (const row of history) {
      log(`  volume ${row.volume} reopened ${row.reopened_at}${row.was_sealed ? ` (sealed since ${row.sealed_at || "unknown"})` : ""}`);
      log(`    reason: ${row.reason}`);
      log(`    record it threw away: ${JSON.stringify(row.rows_at_reopen)}`);
      if (row.copies_affected.length) log(`    copies it marked: ${row.copies_affected.map((v) => `volume ${v}`).join(", ")}`);
    }
    return 0;
  }

  log(`\nreopen-volume — volume ${volume} (${folderName})`);
  log(`  record:  ${path.join(seriesDir, folderName, "series.db")}`);
  log(`  reason:  ${args.reason === null ? "(none given)" : args.reason}`);
  log(`  cascade: ${args.cascade}`);

  const result = rs.reopenVolumeRecord({
    volume,
    folder: folderName,
    seriesDir,
    reason: args.reason,
    cascade: args.cascade,
  });

  if (!result.ok) {
    printRefusal(result.refusal, log);
    return 1;
  }

  const row = result.reopened;
  log(`\n  reopened:  volume ${row.volume} at ${row.reopened_at}`);
  log(`    was sealed: ${row.was_sealed ? `yes, since ${row.sealed_at || "unknown"}` : "no"}`);
  log(`    reason recorded in the record itself (table \`record_reopens\`): ${row.reason}`);
  log(`    the record it retired held: ${JSON.stringify(row.rows_at_reopen)}`);
  log(`  retired to: ${result.retired}`);
  log(`    every sealed row in it is still sealed, and the file is still readable.`);
  log(`  fresh record: ${path.join(seriesDir, result.folder, "series.db")} — carries the reopen history (${row.copies_affected.length ? "with the cascade recorded" : "only"}).`);

  if (result.cascade.length) {
    log(`\n  cascade — ${result.cascade.length} record(s) built on volume ${volume}, retired with the same reason:`);
    for (const c of result.cascade) {
      log(`    volume ${c.volume} (${c.folder}) → ${c.retired || `NOT retired: ${c.because}`}`);
    }
  }

  if (result.windows.length) {
    log(`\n  acceptance windows voided — the grades that let the retired record through its gate:`);
    for (const w of result.windows) {
      for (const item of w.retired) log(`    volume ${w.volume}: ${path.basename(item.file)} → ${path.basename(item.retired)}`);
    }
    log(`    A redone volume is graded on its own merits. Left in place, the acceptance criterion averages`);
    log(`    the window, and the retired record's grade would have decided the new one.`);
  }

  log(`\n  what happens next:`);
  log(`    - the artifacts in these folders are untouched. The door that replaces them moves each one`);
  log(`      aside as it writes its own, and keeps every earlier rejection.`);
  if (volume === 1) {
    log(`    - running volume ${volume} now builds its record from the beginning: no copy-forward (it is`);
    log(`      the first volume), its own published glossary re-imported, its chapters re-read.`);
  } else {
    log(`    - running volume ${volume} now re-derives its record: the fresh file arrives holding only the`);
    log(`      reopen history, so the door that opens it attaches volume ${volume - 1}'s sealed rows again and`);
    log(`      stamps the copy, then re-imports this volume's glossary and re-reads its chapters.`);
    log(`      A reopened volume is NOT a fresh series — without that attach the reference it publishes would`);
    log(`      be smaller than the one it replaced.`);
  }
  if (result.cascade.length) {
    log(`    - running volume ${result.cascade[result.cascade.length - 1].volume} after that copies forward from volume ${volume}'s NEW record, not the retired one.`);
  }
  return 0;
}

if (require.main === module) {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.log(`REFUSED — ${args.error}`);
    console.log(`  see the header of reopen-volume.js for the flags this command takes.`);
    process.exit(1);
  }
  if (!args.volume && !args.list) {
    console.log("REFUSED — reopen-volume.js needs --volume=NN (or --list).");
    process.exit(1);
  }
  loadEnv();
  const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
  main({ args, seriesDir })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("reopen-volume failed:", err);
      process.exit(1);
    });
}

module.exports = { readArgs, main };
