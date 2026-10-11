#!/usr/bin/env node
/**
 * rebuild-voice.js — rebuild one volume's character-voice reference from the extraction output
 * that volume already produced, with **no model call anywhere**.
 *
 * Why this command exists. Volume 01's `character-voice.md` is destroyed (106 lines, one line of
 * 54,341 characters, 3 character sections for a cast of 10, 7 characters with no voice claim at all),
 * while its extraction output — `character-voice-new.json`, 223 structured claims, produced for about
 * 1.1M tokens — is healthy. Re-importing the destroyed file into the reference store faithfully
 * reproduces the damage; rebuilding from the extraction does not. The expensive half of the voice
 * stage is the authoring; the cheap half is the per-chapter extraction, and the cheap half already
 * did its job.
 *
 * The analogy: the extraction is the field notebook and the reference is the written report. This
 * command types the report from the notebook. It does not interview anyone, and it does not read the
 * report that was already ruined.
 *
 * What this command guarantees, in code rather than in a flag you can forget:
 *
 *   - **It is not part of a run.** No stage calls it, no prompt mentions it, and `npx gulp`,
 *     `npm run pipeline` and `npm start` never reach it. The only way it happens is somebody types
 *     this command.
 *   - **It never reads the artifact it is replacing.** The damaged `character-voice.md` is not an
 *     input to anything here, and in rehearsal it is not even copied.
 *   - **It never overwrites an artifact silently.** Without `--apply` the rebuilt file lands in a
 *     copy under `--out`. With `--apply` it replaces the volume's file, and only after that file has
 *     been moved to `character-voice.md.rejected` — kept as evidence, never read by the next volume.
 *   - **Every claim still passes the evidence rule.** A claim whose quotes are nowhere in this
 *     volume's text is refused and named. That gate has no switch here.
 *   - **The result is audited by the same queries as an authored reference**, including the coverage
 *     check at HIGH. Rebuilding does not buy a volume out of covering its cast.
 *   - **Publishing seals the record, and nothing else seals it.** `--apply` writes the reference into
 *     the volume's own folder and then seals the volume's record, because a record is sealed when the
 *     artifact it describes is the artifact the volume actually publishes — and without that seal the
 *     next volume's copy-forward refuses with `reference-volume-unsealed`. A rehearsal with `--out`
 *     publishes nothing, so it seals nothing, and its report says so. There is no flag that seals
 *     without publishing and none that publishes without sealing; a rebuild that audits HIGH damage
 *     writes the file and refuses to seal it.
 *
 * Usage:
 *   node rebuild-voice.js --volume=01 --out=/tmp/opencode/rehearsal   # rehearsal: work on a copy
 *   node rebuild-voice.js --volume=01 --apply --move-aside            # for real
 *   node rebuild-voice.js --volume=01 --out=<dir> \
 *        --alias=俺=如月雨露 --alias-reason="the glossary's own row says the narrator switches between 僕 and 俺"
 *   node rebuild-voice.js --list                                      # what it would do, against which folder
 *
 * Flags:
 *   --volume=NN          required (except with --list)
 *   --series=<dir>       the folder holding the volume folders (default SERIES_LOCATION)
 *   --out=<dir>          rehearsal root: the copy, the record and the rebuilt file all go here
 *   --apply              work in the series folder and replace its artifact
 *   --move-aside         with --apply: move the existing artifact to `.rejected` first (required when
 *                        the volume already has one — a rebuild does not overwrite a reference silently)
 *   --alias=<a>=<key>    declare that a name the extraction used belongs to a roster entry (repeatable)
 *   --alias-reason=<txt> why that link is right; the store records the reason or refuses the link
 *   --report=<path>      where the audit report goes (default: beside the rebuilt file)
 *   --json               also print the machine-readable result
 *
 * Exit codes: 0 nothing found, 2 findings that do not block acceptance, 1 refused or HIGH damage.
 *
 * @module rebuild-voice
 */

const fs = require("fs");
const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const rs = require("./utils/reference-store");
require("./types"); // JSDoc type definitions

/** The artifact this command rebuilds, and the name the next volume reads. */
const VOICE_FILE = "character-voice.md";

/** The extraction output it reads. */
const EXTRACTION_FILE = "character-voice-new.json";

/** Where a rehearsal goes when `--out` is not given. */
const DEFAULT_REHEARSAL_ROOT = "/tmp/opencode/rebuild-voice";

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, series: string|null, out: string|null, apply: boolean, moveAside: boolean, aliases: Array<{alias: string, key: string, reason: string}>, report: string|null, json: boolean, list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = {
    volume: null,
    series: null,
    out: null,
    apply: false,
    moveAside: false,
    aliases: [],
    report: null,
    json: false,
    list: false,
    error: null,
  };
  for (const arg of argv) {
    if (arg === "--apply") out.apply = true;
    else if (arg === "--move-aside") out.moveAside = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--list") out.list = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else if (arg.startsWith("--report=")) out.report = arg.slice("--report=".length);
    else if (arg.startsWith("--alias-reason=")) {
      const last = out.aliases[out.aliases.length - 1];
      if (!last) {
        out.error = "--alias-reason with no --alias before it: a reason has to be attached to a link.";
        return out;
      }
      last.reason = arg.slice("--alias-reason=".length);
    } else if (arg.startsWith("--alias=")) {
      const rest = arg.slice("--alias=".length);
      const at = rest.indexOf("=");
      if (at <= 0 || at === rest.length - 1) {
        out.error = `--alias=${rest} needs the form --alias=<name the extraction used>=<roster entry>`;
        return out;
      }
      out.aliases.push({ alias: rest.slice(0, at), key: rest.slice(at + 1), reason: "" });
    } else {
      out.error = `unrecognised flag: ${arg}`;
      return out;
    }
  }
  if (out.moveAside && !out.apply) {
    out.error = "--move-aside is only meaningful with --apply: without --apply nothing in the series folder is touched.";
  }
  return out;
}

/**
 * Copy one volume's inputs into the rehearsal folder, and leave the damaged artifact behind.
 *
 * The copy is the whole point of rehearsing: the real volume is read and not written. What is copied
 * is what the rebuild reads — the extracted chapters, the extraction output, the glossary. What is
 * deliberately NOT copied is `character-voice.md` and any existing store: the file this command is
 * replacing is not an input to the thing that replaces it, and leaving it out of the copy makes that
 * impossible to get wrong.
 *
 * @param {string} fromDir - The real volume folder.
 * @param {string} toDir - The rehearsal volume folder.
 * @returns {{copied: number, skipped: string[]}}
 */
function stageCopy(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  let copied = 0;
  /** @type {string[]} */
  const skipped = [];
  for (const name of fs.readdirSync(fromDir)) {
    const from = path.join(fromDir, name);
    if (!fs.statSync(from).isFile()) {
      skipped.push(`${name}/`);
      continue;
    }
    if (name === VOICE_FILE || name.startsWith(`${VOICE_FILE}.`) || name.startsWith("series.db")) {
      skipped.push(name);
      continue;
    }
    fs.copyFileSync(from, path.join(toDir, name));
    copied += 1;
  }
  return { copied, skipped };
}

/**
 * Print what this command is about to do, so the operator sees the folder before anything is written.
 *
 * @param {Object} plan
 * @returns {void}
 */
function printPlan(plan) {
  console.log("rebuild-voice — what this command does\n");
  console.log(`  volume:              ${plan.volume}`);
  console.log(`  reads its source in: ${plan.sourceDir}`);
  console.log(`  extraction file:     ${plan.extractionFile} ${plan.extractionExists ? "" : "(MISSING)"}`);
  console.log(`  works and writes in: ${plan.workDir}`);
  console.log(`  replaces the volume's ${VOICE_FILE}: ${plan.apply ? `yes — the old file moves to ${VOICE_FILE}.rejected` : "no — the rebuilt file is written into the copy only"}`);
  console.log(`  aliases declared:    ${plan.aliases.length ? plan.aliases.map((a) => `${a.alias} → ${a.key}`).join(", ") : "none"}`);
  console.log("");
  console.log(`  It does not read the volume's existing ${VOICE_FILE}, and it makes no model call.`);
}

/**
 * Run the rebuild.
 *
 * @param {ReturnType<typeof readArgs>} args
 * @returns {Promise<number>} 0 nothing found, 2 findings that do not block, 1 refused or HIGH damage.
 */
async function main(args) {
  loadEnv();

  if (args.error) {
    console.error(`rebuild-voice: ${args.error}`);
    return 1;
  }
  if (!args.volume && !args.list) {
    console.error("rebuild-voice: --volume=NN is required (or --list to see what this command would do).");
    return 1;
  }

  const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
  if (!seriesDir) {
    console.error("rebuild-voice: no series folder — set SERIES_LOCATION or pass --series=<dir>.");
    return 1;
  }

  /** @type {string} The volume folder name, from the plan of record unless it was passed. */
  let folderName;
  try {
    folderName = rs.referenceStoreVolumeFolder({ seriesDir, volume: args.volume });
  } catch (err) {
    console.error(`rebuild-voice: ${err.message}`);
    return 1;
  }

  const volumeNumber = Number(rs.installmentKey(args.volume));
  const sourceDir = path.join(seriesDir, folderName);
  const rehearsalRoot = path.resolve(args.out || DEFAULT_REHEARSAL_ROOT);
  const workSeriesDir = args.apply ? seriesDir : rehearsalRoot;
  const workDir = path.join(workSeriesDir, folderName);
  const extractionFile = path.join(sourceDir, EXTRACTION_FILE);

  const plan = {
    volume: args.volume,
    sourceDir,
    extractionFile,
    extractionExists: fs.existsSync(extractionFile),
    workDir,
    apply: args.apply,
    aliases: args.aliases,
  };
  printPlan(plan);

  if (!fs.existsSync(sourceDir)) {
    console.error(`\nrebuild-voice: the volume folder is not there: ${sourceDir}`);
    return 1;
  }
  if (args.list) return 0;
  if (!plan.extractionExists) {
    console.error(`\nrebuild-voice: ${EXTRACTION_FILE} is not there. This command rebuilds from the extraction output; it has nothing else to rebuild from.`);
    return 1;
  }
  if (args.apply && !args.moveAside && fs.existsSync(path.join(workDir, VOICE_FILE))) {
    console.error(
      `\nrebuild-voice: ${path.join(workDir, VOICE_FILE)} exists and --move-aside was not given. A rebuild replaces the reference it is rebuilding; saying so is required, and the file it replaces is kept as ${VOICE_FILE}.rejected.`
    );
    return 1;
  }

  // Rehearsal: work on a copy. The real volume is read, never written.
  if (!args.apply) {
    const staged = stageCopy(sourceDir, workDir);
    console.log(`\n  copied ${staged.copied} file(s) into ${workDir}`);
    console.log(`  not copied: ${staged.skipped.join(", ") || "nothing"} — the reference this command replaces is not an input to it.`);
    // The copy deliberately has no record: `stageCopy` skips `series.db*`, and the rehearsal folder holds
    // this volume only. So a rehearsal of a volume that has volumes before it renders **this volume's own
    // claims** — the published file is that plus everything the previous volume's sealed record carries in,
    // and the roster fold that fires when a record is opened never fires here. Measured on the real volume
    // 02: the rehearsal rendered 12 sections; the published file renders 15. Saying so is the difference
    // between a preview and a number dressed as a preview.
    if (volumeNumber > 1) {
      console.log(
        `\n  note: this rehearsal starts with an empty record — ${VOICE_FILE} and series.db* are not copied, and ` +
          `${workSeriesDir} holds only ${folderName}. What it renders is volume ${args.volume}'s own claims, not the ` +
          `accumulated file it would publish, which also carries every earlier volume's sealed record in. Read it as ` +
          `this volume's contribution, not as the artifact.`
      );
    }
  }

  /** @type {Array<Object>} */
  let entries;
  try {
    const parsed = JSON.parse(fs.readFileSync(extractionFile, "utf8"));
    entries = Array.isArray(parsed) ? parsed : parsed.entries || parsed.claims || [];
  } catch (err) {
    console.error(`\nrebuild-voice: ${EXTRACTION_FILE} could not be read: ${err.message}`);
    return 1;
  }

  // The roster comes from the glossary, so the coverage question has something to ask about. The
  // voice half is deliberately not imported: that is the file being rebuilt.
  const glossaryFile = path.join(workDir, "glossary.md");
  if (fs.existsSync(glossaryFile)) {
    const reader = rs.openReferenceStore({ volume: volumeNumber, folder: folderName, seriesDir: workSeriesDir, stage: rs.DOCUMENT_SOURCE_STAGE });
    try {
      const imported = rs.importVolumeArtifacts(reader, { glossaryMarkdown: fs.readFileSync(glossaryFile, "utf8") });
      console.log(`\n  glossary read into the record: ${imported.glossary.importedCount} row(s), ${imported.glossary.castRegistered} character(s), ${imported.glossary.refused.length} refused`);
    } finally {
      reader.close();
    }
  } else {
    console.log("\n  no glossary.md in the working folder: the roster will hold only the names the extraction used, and the coverage check will then be answering a smaller question than the real one.");
  }

  const result = rs.rebuildVoiceVolume({
    volume: volumeNumber,
    folder: folderName,
    seriesDir: workSeriesDir,
    entries,
    aliases: args.aliases,
    // `--apply` is the only thing that publishes, and publishing is the only thing that seals. A
    // rehearsal builds the record and a scratch copy of the file and leaves the record a draft on
    // purpose: sealing a record whose published artifact is somewhere else would publish a record that
    // does not describe the book.
    apply: args.apply,
    moveAside: args.moveAside,
  });

  /** Where the audit report goes — written even when the run is refused, because a refusal is exactly
   *  when somebody needs to read what the audit found. */
  const reportPath = args.report || path.join(args.apply ? workDir : rehearsalRoot, `${VOICE_FILE}-audit.md`);

  if (!result.ok) {
    console.log(`\nrefused: ${result.refusal.rule}`);
    console.log(`  ${result.refusal.because}`);
    console.log(`  fix: ${result.refusal.fix}`);
    if (result.published && result.published.written) {
      console.log(`\n  ${result.published.written} was written, and the record was NOT sealed.`);
    }
    if (result.audit) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, result.audit.markdown, "utf8");
      console.log(`  report:            ${reportPath}`);
    }
    return 1;
  }

  const rebuild = result.rebuild;
  const rendered = result.rendered;
  const audit = result.audit;
  const lines = rendered.markdown.split("\n");

  console.log("\nrebuild");
  console.log(`  claims filed:      ${rebuild.filedCount} this run (${rebuild.carried.length} already in the record)`);
  console.log(`  refused:           ${rebuild.refused.length}`);
  console.log(
    `  the record now:    ${rebuild.adoptedClaims} claim(s) about ${rebuild.adoptedCharacters} character(s), ` +
      `${rebuild.candidateClaims} candidate copy(ies) beside them` +
      (rebuild.adoptedUnkeyed ? `, ${rebuild.adoptedUnkeyed} with no character` : "")
  );
  console.log(`  POV claims:        ${rebuild.povAttached} attached, ${rebuild.povUnattached} with no character`);
  console.log(
    `  candidate copies:  ${rebuild.candidates.filed} filed this run, ${rebuild.candidates.carried} already there, ` +
      `${rebuild.candidates.refused.length} could not be filed`
  );
  if (result.aliases.applied.length) console.log(`  aliases applied:   ${result.aliases.applied.map((a) => `${a.alias} → ${a.key}`).join(", ")}`);
  for (const aliasRefusal of result.aliases.refused) console.log(`  alias refused:     ${aliasRefusal.alias} → ${aliasRefusal.key}: ${aliasRefusal.because}`);
  if (rebuild.unresolved.length) {
    console.log(`  names the roster does not carry: ${rebuild.unresolved.map((u) => `${u.name} → filed as ${u.key}`).join(", ")}`);
    console.log("    these became roster entries of their own. Declare the link with --alias=<name>=<entry> --alias-reason=\"…\" when they are somebody the glossary already knows.");
  }

  console.log("\nrendered reference");
  console.log(`  sections:          ${rendered.sections}`);
  console.log(`  lines:             ${lines.length}`);
  console.log(`  characters:        ${lines.filter((line) => line.startsWith("### ")).length}`);
  console.log(`  longest line:      ${Math.max(0, ...lines.map((line) => line.length))} characters`);
  console.log(`  truncated bullets: ${rendered.truncated}`);
  console.log(`  not rendered:      ${rendered.unattached} POV claim(s) with no character to file them under (they stay in the record)`);

  console.log("\naudit");
  console.log(`  findings:          ${audit.findings.length} (${audit.highFindings.length} HIGH)`);
  for (const item of audit.findings) console.log(`    ${item.severity} ${item.kind}: ${item.message.slice(0, 240)}`);

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, audit.markdown, "utf8");
  console.log(`  report:            ${reportPath}`);

  if (result.published) {
    const published = result.published;
    console.log("\npublished");
    console.log(`  wrote:             ${published.written}`);
    if (published.unchanged) console.log("  the file already on disk is exactly what this record renders, so nothing was replaced and no new `.rejected` was made.");
    if (published.moved) console.log(`  the file it replaced is kept as ${published.moved}`);
    console.log(`  record sealed:    yes — ${published.sealed.rows} row(s) owned by volume ${volumeNumber} are now published and immutable`);
    console.log(`                    (sealed at ${published.sealed.at}; ${published.sealed.snapshot} fact(s) frozen into this volume's snapshot)`);
    console.log("  the next volume's copy-forward may now build on this record.");
  } else {
    fs.writeFileSync(path.join(workDir, VOICE_FILE), rendered.markdown, "utf8");
    console.log(`\n  rehearsal copy written to ${path.join(workDir, VOICE_FILE)} — nothing in the series folder was touched.`);
    console.log("  the record is NOT sealed: a rehearsal publishes nothing, and only a published reference earns a sealed record.");
  }

  if (args.json) {
    console.log(
      `\n${JSON.stringify(
        {
          rebuild,
          rendered: { sections: rendered.sections, characters: rendered.characters, unattached: rendered.unattached, truncated: rendered.truncated },
          published: result.published
            ? { written: result.published.written, moved: result.published.moved, sealed: result.published.sealed }
            : null,
          findings: audit.findings,
        },
        null,
        2
      )}`
    );
  }

  if (audit.highFindings.length) {
    console.log(`\n${audit.highFindings.length} HIGH finding(s): this reference is damaged, and the next volume's copy-forward will refuse it.`);
    return 1;
  }
  if (audit.findings.length) {
    console.log(`\n${audit.findings.length} finding(s), none HIGH.`);
    return 2;
  }
  console.log("\nno findings.");
  return 0;
}

const args = readArgs(process.argv.slice(2));
main(args)
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\nrebuild-voice failed: ${err.message}`);
    if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  });
