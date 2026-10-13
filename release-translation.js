#!/usr/bin/env node
/**
 * release-translation.js — the only door past the freeze gate, and it is a recorded act.
 *
 * `utils/prereqs/freeze.js` refuses to rewrite a pre-production artifact that a published translation
 * was already built from: rewrite volume 5's glossary after volumes 1–8 are translated and the run
 * prints "already accepted, skipping" for eight translations built from a glossary that no longer
 * exists. That gate has **no flag, no environment variable, no ledger entry and no run policy** on it,
 * for the reason AGENTS.md §4 rule 3 gives: a guard the role can switch off is not a guard. This
 * command is the way through — and the way through is not a switch, it is **saying, in writing, that
 * these volumes' translations no longer vouch for what the references now say.**
 *
 * It is the shape `reopen-volume.js` established (gotcha 113): a typed reason refused under 20
 * characters (the same floor `reopen` holds — "redo" is the act restated, not a reason), a row in the
 * run's own records naming the volumes it invalidates and the artifacts it is about to rewrite, and
 * nothing done to a translation.
 *
 * **What this command does NOT do.** It does not delete, edit, mark, move or schedule a single file in
 * a volume folder. `translation.md` stays exactly where it is, byte for byte. A release changes what
 * the pipeline is *allowed to do next*, not what has already been published — and that is the whole
 * design: the alternative (a release that also wiped the translations) would make the freeze gate a
 * delete button, and a mistake here would destroy finished work rather than expose it.
 *
 * **A release is standing.** It does not expire, and it does not get consumed by one run. The
 * translation artifacts stay on disk, so a release that expired would make the volume impossible to
 * rebuild: the gate would refuse the very act the release was typed to allow. It is therefore named in
 * the resume triage and the delivery report for as long as it exists, so nobody has to remember that
 * volume 02's translation was invalidated in March.
 *
 * **Per door, on purpose.** Releasing `glossary` does not release `character-voice`. Each door is a
 * different artifact, a different act, and a different reason; the reason has to be typed for each one.
 * A manual door (`rebuild-voice`, `extract-voice`, `reopen-volume`, `attribute-voice`) is covered by a
 * release naming its owning stage, because the artifact it threatens is that stage's artifact.
 *
 * Usage:
 *   node release-translation.js --volume=01,02 --door=glossary --reason="the glossary missed the running joke in ch4 and every later volume copied it forward"
 *   node release-translation.js --list
 *   node release-translation.js --list --volume=02
 *
 * Flags:
 *   --volume=NN[,NN]   the volumes whose translation this invalidates (required to record; optional
 *                      with --list, which then narrows what it prints)
 *   --door=<name>      the door being released, one of: glossary, character-voice, style-guide,
 *                      jump-in-wiki, consistency-audit, discover, extract, rebuild-voice,
 *                      extract-voice, reopen-volume, attribute-voice
 *   --reason="…"       required, at least 20 characters
 *   --series=<dir>     the folder holding the volume folders (default SERIES_LOCATION)
 *   --list             print the releases this run already holds, and stop. Writes nothing.
 *
 * Exit codes: 0 the release is recorded (or --list printed), 1 refused.
 *
 * @module release-translation
 */

const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { readVolumesInScope } = require("./utils/prereqs");
const fz = require("./utils/prereqs/freeze");
require("./types"); // JSDoc type definitions

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volumes: string[], doors: string[], reason: string|null, series: string|null, list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { volumes: [], doors: [], reason: null, series: null, list: false, error: null };
  for (const arg of argv) {
    if (arg === "--list") out.list = true;
    else if (arg.startsWith("--volume=")) out.volumes = arg.slice("--volume=".length).split(",").map((v) => v.trim()).filter(Boolean);
    else if (arg.startsWith("--door=")) out.doors = arg.slice("--door=".length).split(",").map((d) => d.trim()).filter(Boolean);
    else if (arg.startsWith("--reason=")) out.reason = arg.slice("--reason=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else out.error = `unrecognised flag: ${arg}`;
  }
  return out;
}

/**
 * Print one refusal the way this family of commands prints all of them.
 *
 * @param {{rule: string, because: string, fix?: string}} refusal
 * @param {(line: string) => void} log
 * @returns {void}
 */
function printRefusal(refusal, log) {
  log(`\nREFUSED — ${refusal.rule}`);
  log(`  ${refusal.because}`);
  if (refusal.fix) log(`  fix: ${refusal.fix}`);
}

/**
 * Print the releases this run already holds, and what each one still lets through.
 *
 * Read-only: `--list` writes nothing and calls nothing, which is what makes it safe to run against a
 * live corpus.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {string[]} [opts.volumes] - Narrow the print to these volumes.
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<number>} The process exit code.
 */
async function printReleases({ seriesDir, volumes = [], log = console.log }) {
  const read = fz.readTranslationReleases();
  log(`\nrelease-translation — the freeze gate's recorded acts`);
  log(`  record: ${read.file}`);
  if (read.error) {
    log(`\n  ${read.error}`);
    return 1;
  }
  if (read.releases.length === 0) {
    log("\n  none. Every pre-production artifact a published translation was built from is frozen.");
    log(`  The gate covers: ${fz.frozenDoors().join(", ")}.`);
    return 0;
  }

  const wanted = volumes.map((v) => String(v));
  /** @type {Map<string, Set<string>>} installment → the doors currently released for it */
  const open = new Map();
  for (const r of read.releases) {
    if (wanted.length && !r.volumes.some((v) => wanted.includes(String(v)))) continue;
    log(`\n  ${r.id}  ${r.at}`);
    log(`    volumes: ${r.volumes.join(", ")}`);
    log(`    doors:   ${r.doors.join(", ")}`);
    log(`    rewrites: ${r.artifacts.join(", ") || "(nothing this pipeline declares)"}`);
    log(`    invalidates: ${r.invalidated.join(", ") || "(no declared translation output)"}`);
    log(`    reason:  ${r.reason}`);
    log(`    by:      ${r.by}`);
    for (const installment of r.volumes) {
      if (!open.has(String(installment))) open.set(String(installment), new Set());
      for (const door of r.doors) open.get(String(installment)).add(String(door));
    }
  }

  log(`\n  Still open (a run may rewrite these today, and the resume report names them):`);
  if (open.size === 0) {
    log("    nothing for the volumes you named.");
    return 0;
  }
  for (const [installment, doors] of [...open.entries()].sort()) {
    log(`    volume ${installment}: ${[...doors].sort().join(", ")}`);
  }
  return 0;
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
  if (args.error) {
    console.error(`release-translation: ${args.error}`);
    return 1;
  }
  if (args.list) return printReleases({ seriesDir, volumes: args.volumes, log });

  if (args.volumes.length === 0) {
    printRefusal(
      {
        rule: "no-volume",
        because: "name the volumes whose translation this invalidates: --volume=01,02.",
        fix: "node release-translation.js --list to see what is frozen, and --volume=NN to narrow it.",
      },
      log
    );
    return 1;
  }
  if (args.doors.length === 0) {
    printRefusal(
      {
        rule: "no-door",
        because: `name the door you are releasing. This gate covers: ${fz.frozenDoors().join(", ")}.`,
        fix: `--door=${args.doors.length ? args.doors.join(",") : "glossary"}`,
      },
      log
    );
    return 1;
  }

  // The volumes have to be volumes this series actually has. A release typed against a folder that
  // does not exist is a record of nothing, and the record is what every later run reads.
  const scope = readVolumesInScope(seriesDir, null);
  if (scope.error) {
    printRefusal({ rule: "no-plan-of-record", because: scope.error, fix: "run `npx gulp discover` first, or pass --series=<dir>." }, log);
    return 1;
  }
  /** @type {Map<string, string>} installment → folder */
  const known = new Map();
  for (const entry of scope.volumes) known.set(String(entry.installmentNumber || entry.folder), entry.folder);

  const asked = args.volumes.map((v) => String(v).trim());
  const unknown = asked.filter((v) => !known.has(v));
  if (unknown.length) {
    printRefusal(
      {
        rule: "unknown-volume",
        because: `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not a volume of ${path.basename(seriesDir)}. This series has: ${[...known.keys()].join(", ")}.`,
        fix: "a release names volumes this series actually has, because the record it writes is read against those folders.",
      },
      log
    );
    return 1;
  }

  const result = fz.recordTranslationRelease({ volumes: asked, doors: args.doors, reason: args.reason || "" });
  if (!result.ok) {
    printRefusal({ rule: result.refusal.rule, because: result.refusal.because }, log);
    return 1;
  }

  const r = result.release;
  log(`\nRELEASED — ${r.id}`);
  log(`  recorded in: ${result.file}`);
  log(`  volumes:   ${r.volumes.join(", ")}`);
  log(`  doors:     ${r.doors.join(", ")}`);
  log(`  rewrites:  ${r.artifacts.join(", ") || "(nothing this pipeline declares)"}`);
  log(`  invalidates: ${r.invalidated.join(", ") || "(no declared translation output)"}`);
  log(`  reason:    ${r.reason}`);
  log(
    `\n  Nothing was done to a translation. ${r.invalidated.join(", ") || "The translation files"} ${
      r.invalidated.length === 1 ? "stands" : "stand"
    } where ${r.invalidated.length === 1 ? "it is" : "they are"}.\n` +
      `  What changed is what the pipeline is now allowed to rewrite: the doors above may rebuild those\n` +
      `  volumes, and the resume triage and the delivery report name this release for as long as it holds.\n` +
      `  Re-run the step you released (for example: npx gulp ${r.doors[0]}${r.volumes.length === 1 ? ` --volume ${r.volumes[0]}` : ""}).`
  );
  return 0;
}

if (require.main === module) {
  loadEnv();
  const args = readArgs(process.argv.slice(2));
  const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
  if (!seriesDir) {
    console.error("release-translation: no series folder — set SERIES_LOCATION or pass --series=<dir>.");
    process.exit(1);
  }
  main({ args, seriesDir })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String((err && err.stack) || err));
      process.exit(1);
    });
}

module.exports = { readArgs, main, printReleases };
