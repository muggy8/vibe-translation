#!/usr/bin/env node
/**
 * extract-voice.js — read one volume chapter by chapter and write its extraction output, and
 * nothing else.
 *
 * Why this command exists. The voice stage pays twice: the extraction pass reads the book and
 * writes a structured notebook (`character-voice-new.json`), and the author pass re-types that
 * notebook into `character-voice.md`. Measured on volume 01: the notebook cost about 1.1M tokens and
 * is healthy; the authoring cost 50M and produced a reference a grader scored 48/100, and the
 * validation pass that followed cost 62.5M. `rebuild-voice.js` already knew how to type the report
 * from the notebook without a model — but until now the notebook could only be produced by running
 * the expensive half next to it. This command unbolts the reading step from the writing step, and it
 * is also how the reading half is run by hand: one volume, or one chapter of one volume.
 *
 * The route, in the order it is meant to be run:
 *
 *   node extract-voice.js  --volume=02            # read the book: N chapters, N calls
 *   node rebuild-voice.js  --volume=02 --apply    # type the reference from it, publish, seal
 *
 * The pipeline's character-voice stage now runs the same reading pass by default
 * (`character-voice/assemble.js`), so this command is the manual door onto the normal route rather
 * than a separate route of its own. It stays a command because a person sometimes needs to read one
 * volume, or one chapter, without building the volume around it.
 *
 * What this command guarantees, in code rather than in a flag you can forget:
 *
 *   - **It writes the notebook and the record, and never the artifact.** The only files it writes
 *     in a volume folder are `character-voice-extract-<chapter>.json` partials,
 *     `character-voice-new.json`, and the volume's own `series.db`. It contains no statement that
 *     writes `character-voice.md` or `pov-map.md`, and it does not seed either from the previous
 *     volume.
 *   - **It seals nothing.** Only publishing seals a record (`rebuild-voice.js`), and this command
 *     publishes nothing.
 *   - **It refuses a volume whose record is already sealed.** A sealed record is a published one;
 *     filing new claims beside it would put unpublished claims inside a record a translation was
 *     already built on. Volume 01 is sealed, so this command cannot touch it.
 *   - **Every claim it files goes through the evidence rule**, the same gate every other row goes
 *     through, and each refusal is printed with its reason. There is no switch here.
 *   - **One malformed claim does not cancel a chapter.** When an answer does not parse as a whole,
 *     its array is read claim by claim: every claim that parses on its own is kept, every one that
 *     does not is dropped and named, and the answer that could not be read is kept in the partial so
 *     it can be re-read without paying for the chapter again. A chapter that yields nothing at all
 *     still refuses the pass — a notebook with a hole in it is not a notebook.
 *   - **A cut-off chapter is detected, named, and re-read.** An answer whose array never reached its
 *     closing bracket is half an answer, and the pass does not accept it at 6 claims. It is retried
 *     once at the retry level and the better answer wins **within that pass** — a chapter re-read by name
 *     replaces the answer the earlier pass stored, whatever that answer held (gotcha 122); a chapter still
 *     cut off after both
 *     paid reads is kept and printed as INCOMPLETE, and named in the report the grader reads. Measured
 *     on volume 02: three of seven chapters came back cut off, and two of them yielded 6 and 1 claims
 *     for chapters of 33.5k and 35.5k characters.
 *   - **It opens the volume's record through the same door the pipeline uses** — copy-forward from
 *     the previous volume's sealed record, the glossary completeness rule, and the roster fold. The
 *     reading pass is told to extract only what this chapter adds to what is already known, and
 *     "what is already known" is that record; a route that skipped it would be answering a
 *     different question than the stage answers.
 *   - **It is resumable, and resume is free.** Each chapter's answer is written to its own partial
 *     as soon as it arrives, tagged with a fingerprint of the chapter text it came from. A second
 *     invocation reuses those partials and makes no call for them. `--force` is the way to pay for a
 *     chapter twice; `--chapter=<id>` is the way to pay for exactly one.
 *
 * Usage:
 *   node extract-voice.js --volume=02                        # for real
 *   node extract-voice.js --volume=02 --dry-run              # the exact prompts, no call
 *   node extract-voice.js --volume=02 --force                # re-read every chapter
 *   node extract-voice.js --volume=02 --chapter=ch4          # re-read one chapter, reuse the rest
 *   node extract-voice.js --volume=02 --series=<dir>         # a different series folder
 *   node extract-voice.js --list                             # which folder, which chapters, no call
 *
 * Flags:
 *   --volume=NN        required (except with --list)
 *   --series=<dir>     the folder holding the volume folders (default SERIES_LOCATION)
 *   --dry-run          write the prompts a live run would send; make no model call
 *   --force            re-extract chapters that already have a usable partial
 *   --chapter=<id>     re-read exactly this chapter (repeatable); every other chapter is reused
 *   --list             print what it would do and stop
 *
 * Exit codes: 0 the notebook is complete, 2 it is complete but some claims were refused or a chapter
 * is incomplete, 1 refused or failed.
 *
 * @module extract-voice
 */

const fs = require("fs");
const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { validateRequiredEnv } = require("./configs/shared");
const { transformUserPrompt, writePromptDump } = require("./utils/prompt");
const { openSeriesRun, locatePreviousVolume } = require("./utils/series-run");
const { assertDoorAllowed } = require("./utils/prereqs/freeze");
const { resolveSourceBundle, chapterSegmentNote } = require("./utils/source");
const rs = require("./utils/reference-store");
const { buildAlreadyExtractedNote, buildExtractSystemPrompt } = require("./character-voice/prompts");
const { KNOWN_FACTS_HEADING } = require("./character-voice/known-facts");
const { openVoiceRecord, fileVoiceExtraction, describeVoiceRefusals } = require("./character-voice/store");
const reading = require("./character-voice/reading");
const { extractSystemPromptFile, extractUserPromptTemplateFile } = require("./character-voice/config");
require("./types"); // JSDoc type definitions

/** The notebook the voice stage already writes under this name; this command writes the same one. */
const EXTRACTION_FILE = reading.EXTRACTION_FILE;

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, series: string|null, dryRun: boolean, force: boolean, chapters: string[], list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { volume: null, series: null, dryRun: false, force: false, chapters: [], list: false, error: null };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--list") out.list = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else if (arg.startsWith("--chapter=")) out.chapters.push(arg.slice("--chapter=".length));
    else out.error = `unrecognised flag: ${arg}`;
  }
  if (out.chapters.length && out.force) {
    out.error = "--chapter and --force contradict each other: one names chapters to re-read, the other re-reads all of them.";
  }
  return out;
}

/**
 * What this command says about the series' register declaration, before it reads a single chapter.
 *
 * Three states, and the command says all three out loud rather than filing quietly. It is the
 * "named, not punished" shape plan 06 §10.11 recommends: `extract-voice` is the door a person uses to
 * read a volume when the stage will not run, so refusing here would close the only working door for a
 * series whose intake has not re-run — and printing nothing would let a register-blind artifact be
 * published by hand with no record of it having been blind.
 *
 * @param {{state: string, axes: Array<Object>, note: string|null, file: string}} declaration - What
 *   `readRegisterDeclaration` answered.
 * @returns {string[]} One line to print. Never empty.
 */
function registerAnnouncementLines(declaration) {
  const state = declaration && declaration.state ? declaration.state : "absent";
  const axes = declaration && Array.isArray(declaration.axes) ? declaration.axes : [];
  if (state === "declared" && axes.length) {
    return [
      `  register: this series declares ${axes.length} register question(s) — ` +
      axes.map((axis) => `"${axis.id}" (${axis.asks})`).join("; ") +
      ". The reading pass is asked those, and only those.",
    ];
  }
  if (state === "empty") {
    return [
      `  register: this series declares no register questions, and says why: "${declaration.note}". ` +
      "The reading pass is asked none, and no claim it files answers a register question.",
    ];
  }
  const because = state === "malformed"
    ? `the "${rs.REGISTER_MANIFEST_KEY}" block in ${declaration.file || "the plan of record"} is present but malformed`
    : `the plan of record (${declaration.file || "translation-target.json"}) carries no "${rs.REGISTER_MANIFEST_KEY}" block`;
  return [
    `  register: ${because}, so this volume is filed with NO register axis — every claim it files answers ` +
    "no register question, and a claim that named one would be refused at filing because there is no " +
    "question list in the pipeline to check it against. The door that declares them is the intake: npx gulp discover.",
  ];
}

/**
 * Read one volume chapter by chapter and write its notebook.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {string} opts.volumeArg - The `--volume` value, resolved through the plan of record.
 * @param {boolean} [opts.dryRun] - Dump the prompts, call nothing.
 * @param {boolean} [opts.force] - Re-read chapters that already have a usable partial.
 * @param {string[]|null} [opts.chapters] - Re-read exactly these chapters and reuse the rest.
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, refusal: Object|null, volume: string, folder: string, chapters: Array<Object>, entries: number, refusedClaims: Array<Object>, incompleteChapters: string[], record: Object|null, extractionFile: string|null, dryRun: boolean}>}
 */
async function runExtractPass({ seriesDir, volumeArg, dryRun = false, force = false, chapters: onlyChapters = null, log = console.log }) {
  const baseSystemPrompt = await fs.promises.readFile(extractSystemPromptFile, "utf8");
  const template = await fs.promises.readFile(extractUserPromptTemplateFile, "utf8");

  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  if (volumes.length !== 1) {
    return {
      ok: false,
      refusal: { rule: "one-volume-only", because: `this command reads one volume per invocation; --volume=${volumeArg || "<NN>"} selected ${volumes.length}.`, fix: 'pass exactly one volume, e.g. --volume=02' },
      volume: String(volumeArg), folder: "", chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun,
    };
  }

  const folderName = volumes[0];
  const index = folders.indexOf(folderName);
  const volumeEntry = volumeByFolder.get(folderName);
  const volumeDir = path.join(seriesDir, folderName);
  const installmentNumber = volumeEntry.installmentNumber;
  const { isFirst, previousFolderName, previousInstallmentNumber } = locatePreviousVolume({ folders, index, volumeByFolder });

  log(`\nextract-voice — volume ${installmentNumber} (${folderName})`);
  log(`  reads:   ${volumeDir}`);
  log(`  base:    ${isFirst ? "none (first volume)" : `${previousFolderName}/character-voice.md`}`);

  if (!fs.existsSync(volumeDir)) {
    return { ok: false, refusal: { rule: "volume-folder-missing", because: `${volumeDir} is not there.`, fix: "check --series and the plan of record." }, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun };
  }

  // The freeze gate. This command re-reads the volume chapter by chapter and re-files its reference
  // record, and the published reference is what a published translation was rendered from. A volume
  // whose translation is already on disk is not this command's to re-read; the way past is a recorded
  // release (node release-translation.js), not a flag. There is no flag here.
  try {
    await assertDoorAllowed({
      door: "extract-voice",
      seriesDir,
      cancelledBy: "act",
      volumes: [volumeEntry],
      dryRun,
      log,
    });
  } catch (err) {
    return {
      ok: false,
      refusal: {
        rule: "volume-frozen",
        because: String((err && err.message) || err),
        fix: `record the act first: node release-translation.js --volume=${installmentNumber} --door=extract-voice --reason="…"`,
      },
      volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun,
    };
  }

  // The same source resolution the stage uses: the extracted chapter files the evidence rule cites.
  const bundle = await resolveSourceBundle({ seriesDir, volume: volumeEntry, volumeDir, force: false });
  const segments = bundle.segments && bundle.segments.length ? bundle.segments : [];
  log(`  chapters: ${segments.length} segment(s), ${bundle.wholeChars} characters whole — read one at a time`);

  // The series' register declaration, read from its own plan of record. This door does **not** refuse a
  // series that has none — that refusal belongs to the stage, which renders an artifact out of the
  // answers and cannot render answers it was never asked for. Here the honest shape is "named, not
  // punished" (plan 06 §10.11): the volume is still read and still filed, and the run says out loud that
  // nothing it files answers a register question. What the reading pass is *shown* is the same block the
  // stage shows, so the two doors cannot ask a book two different questions.
  const registerDeclaration = rs.readRegisterDeclaration(seriesDir);
  const extractSystemPrompt = buildExtractSystemPrompt(baseSystemPrompt, registerDeclaration);
  for (const line of registerAnnouncementLines(registerDeclaration)) log(line);

  const values = {
    INSTALLMENT_NUMBER: installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  /** The ctx `character-voice/reading.js`'s own extraction pass reads. Built the way the stage builds it. */
  const ctx = {
    values,
    folderName,
    volumeDir,
    seriesDir,
    sourceFile: bundle.wholePath,
    bundle,
    isFirst,
    previousFolderName: previousFolderName || null,
    previousVoiceRefFile: isFirst ? null : path.join(seriesDir, previousFolderName, "character-voice.md"),
    voiceOutputFile: path.join(volumeDir, "character-voice.md"),
    extractPrompt: transformUserPrompt(template, values),
    extractSystemPrompt,
    registerDeclaration,
    refStore: null,
  };

  if (dryRun) {
    const sections = [
      { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
      { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
      {
        title: "What a live run would also send (NOT included in this preview)",
        prompt:
          "Every chapter call is also shown a block built from this volume's **reference record**: the " +
          "record's current claims about the characters this chapter's own text names, as of volume " +
          `${installmentNumber} (${KNOWN_FACTS_HEADING}).\n` +
          "It is absent here on purpose — a --dry-run opens no record, and the block is a query over that " +
          "record rather than a file that could be read off disk. A live run with no record open is refused " +
          "(`no-reference-record`) before it makes a single call.",
      },
    ];
    // The preview has to show what a live run would actually send, and a live run's note is built
    // from the partials already on disk. Reading them here costs nothing and keeps the preview from
    // claiming "nothing yet" for a chapter that would be shown a full list.
    /** @type {Array<Object>} */
    const previewEntries = [];
    /** @type {string[]} */
    const previewDone = [];
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const note = buildAlreadyExtractedNote({
        installmentNumber,
        segmentsTotal: segments.length,
        doneSegments: previewDone,
        entries: previewEntries,
      });
      const partial = reading.readPartial(volumeDir, seg, reading.segmentFingerprint(path.join(volumeDir, seg.file)));
      if (partial.usable) {
        previewEntries.push(...partial.entries);
        previewDone.push(seg.id);
      }
      sections.push({
        title: `CHUNKED — per-chapter extraction user prompt (${seg.id})`,
        prompt: `${ctx.extractPrompt}\n\n${chapterSegmentNote(bundle, seg, si)}\n\n${
          note ||
          (si === 0
            ? "(first chapter of the pass: nothing extracted yet)"
            : `(${segments.slice(0, si).map((s) => s.id).join(", ")} would be listed here in a live run; this preview has no partial for them on disk, so there is nothing to list.)`)
        }`,
      });
    }
    const dumpFile = await writePromptDump("extract-voice", installmentNumber, "one-shot", sections);
    log(`\n  --dry-run: prompts dumped to ${dumpFile} — no model call, nothing written to the volume folder.`);
    log("  each live chapter call is also shown the record query block described above; this preview does not carry it, because a --dry-run opens no record and the block is a query, not a file.");
    return { ok: true, refusal: null, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun: true };
  }

  // The volume's record, opened through the pipeline's own door: copy-forward from the previous
  // volume's sealed record, the glossary completeness rule, the roster fold. Not behind
  // VOICE_STORE_VALIDATORS — a guard with an env knob on it is not a guard (AGENTS.md rule 3).
  const attempt = openVoiceRecord(ctx, previousInstallmentNumber);
  if (!attempt.ok) {
    return { ok: false, refusal: { rule: "record-refused", because: attempt.error, fix: "see the refusal above." }, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun };
  }
  const store = attempt.opened.store;
  ctx.refStore = store;

  try {
    if (rs.isVolumeSealed(store, store.volume)) {
      return {
        ok: false,
        refusal: {
          rule: "extract-volume-sealed",
          because:
            `volume ${store.volume}'s reference record is sealed: its published reference is already ` +
            "the one the next volume builds on. This command files new claims into the record it opens, " +
            "and a published record is contested through the store's challenge door, not re-read.",
          useInstead: [`rebuild-voice.js --volume=${store.volume} (it refuses a sealed record too)`, "the challenge path, for a claim that is published and wrong"],
          fix: "this command is for a volume that has not been published yet.",
        },
        volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], incompleteChapters: [], record: null, extractionFile: null, dryRun,
      };
    }

    const carried = attempt.opened.carried;
    const topped = attempt.opened.toppedUp;
    if (carried) {
      const counts = carried.provenance.copiedRows;
      log(`  record:  carried forward from volume ${previousInstallmentNumber} (${counts.facts} facts, ${counts.cast} characters)`);
    } else if (topped && topped.reattached) {
      log(`  record:  this volume had been reopened, so its record arrived empty — volume ${previousInstallmentNumber}'s ${topped.total} row(s) were attached and the copy stamped`);
    } else if (topped && topped.total > 0) {
      log(`  record:  topped up from volume ${previousInstallmentNumber} (${topped.total} row(s) this record was missing)`);
    } else if (topped && topped.skipped && topped.reason && !/has not changed/.test(topped.reason)) {
      log(`  record:  NOT topped up from volume ${previousInstallmentNumber} — ${topped.reason}`);
    }
    const backfill = attempt.opened.glossaryBackfill;
    if (backfill && backfill.ran) {
      log(`  record:  read this volume's glossary.md into itself — ${backfill.imported} new row(s), ${backfill.carried} carried, ${backfill.refused.length} refused, ${backfill.castRegistered} roster entr(ies)`);
    }
    for (const line of rs.rosterReconciliationLog(installmentNumber, attempt.opened.roster)) log(line);

    const read = await reading.readVolumeChapters({
      ctx,
      segments,
      volumeDir,
      installmentNumber,
      force,
      onlyChapters,
      log,
    });
    if (!read.ok) {
      return {
        ok: false,
        refusal: read.refusal,
        volume: String(installmentNumber),
        folder: folderName,
        chapters: read.chapters.map((c) => ({ id: c.id, claims: c.entries.length, reused: c.reused })),
        entries: reading.consolidateExtraction(read.chapters).length,
        refusedClaims: [],
        incompleteChapters: read.chapters.filter((c) => c.incomplete).map((c) => c.id),
        record: attempt.opened,
        extractionFile: null,
        dryRun,
      };
    }
    const chapters = read.chapters;

    const entries = reading.consolidateExtraction(chapters);
    const extractionFile = path.join(volumeDir, EXTRACTION_FILE);
    const temp = `${extractionFile}.writing`;
    await fs.promises.writeFile(temp, JSON.stringify(entries, null, 2) + "\n", "utf8");
    await fs.promises.rename(temp, extractionFile);
    const called = chapters.reduce((sum, c) => sum + (c.paidReads || 0), 0);
    const reusedCount = chapters.filter((c) => c.reused).length;
    log(`\nnotebook`);
    log(`  ${EXTRACTION_FILE}: ${entries.length} claim(s) from ${chapters.length} chapter(s) — ${called} model call(s), ${reusedCount} chapter(s) reused`);
    log(`  written: ${extractionFile}`);

    const report = reading.readingReport(chapters, { volume: installmentNumber });
    if (report) {
      const reportFile = path.join(volumeDir, "character-voice-reading.md");
      await fs.promises.writeFile(reportFile, `# How volume ${installmentNumber} was read\n\n${report}`, "utf8");
      log(`  how it was read: ${reportFile}`);
    }

    const voice = fileVoiceExtraction(ctx, entries) || { importedCount: 0, carried: [], refused: [], characters: 0, povCount: 0, unresolved: [], imported: [] };
    log(`  record filed: ${voice.importedCount} claim(s) about ${voice.characters} character(s), ${voice.povCount} POV claim(s), ${voice.carried.length} already filed`);
    log(`  refused:      ${describeVoiceRefusals(voice.refused)}`);
    // The outcome, printed beside the promise. The line above this pass says what the series declares;
    // this one says what this volume actually filed, because a declaration nobody answered is the fact
    // the account owner needs and a declaration that exists is not that fact (plan 06 §10.11).
    const axisBearing = (voice.imported || []).filter((fact) => fact && fact.axis).length;
    if (axisBearing) {
      log(`  axis:         ${axisBearing} of the ${voice.importedCount} claim(s) filed answer a declared register question`);
    } else if (voice.importedCount) {
      log(`  axis:         NO register axis — none of the ${voice.importedCount} claim(s) this volume filed answers a register question.`);
    }
    for (const item of voice.refused.slice(0, 40)) log(`    ${item.character || "(no character)"} ${item.label || item.kind}: ${item.because}`);
    if (voice.unresolved && voice.unresolved.length) {
      log(`  names the roster does not carry: ${voice.unresolved.map((u) => `${u.name} → filed as ${u.key}`).join(", ")}`);
    }

    const incompleteChapters = chapters.filter((c) => c.incomplete).map((c) => c.id);
    return {
      ok: true,
      refusal: null,
      volume: String(installmentNumber),
      folder: folderName,
      chapters: chapters.map((c) => ({ id: c.id, claims: c.entries.length, reused: c.reused, paidReads: c.paidReads, incomplete: c.incomplete })),
      entries: entries.length,
      refusedClaims: voice.refused,
      incompleteChapters,
      record: { carried: attempt.opened.carried, toppedUp: attempt.opened.toppedUp, glossaryBackfill: attempt.opened.glossaryBackfill, roster: attempt.opened.roster, voice },
      extractionFile,
      dryRun: false,
    };
  } finally {
    // Closed, never sealed: a record is sealed when the artifact it describes is published, and this
    // command publishes nothing. `rebuild-voice.js --apply` is what publishes, and it is what seals.
    try { store.close(); } catch { /* already closed */ }
    ctx.refStore = null;
  }
}

/**
 * Print what this invocation is about to do, before anything is opened.
 *
 * @param {ReturnType<typeof readArgs>} args
 * @param {string} seriesDir
 * @returns {void}
 */
function printPlan(args, seriesDir) {
  console.log("extract-voice — what this command does\n");
  console.log(`  volume:        ${args.volume}`);
  console.log(`  series folder: ${seriesDir}`);
  console.log(`  writes:        character-voice-extract-<chapter>.json, ${EXTRACTION_FILE}, and this volume's series.db`);
  console.log(`  it does NOT write: character-voice.md or pov-map.md, and it seals nothing.`);
  if (args.chapters.length) console.log(`  re-reading:    ${args.chapters.join(", ")} — every other chapter is reused from its partial and costs nothing`);
  console.log(`  next step:     node rebuild-voice.js --volume=${args.volume} --apply\n`);
}

const args = readArgs(process.argv.slice(2));

if (require.main === module) {
  (async () => {
    loadEnv();
    if (args.error) {
      console.error(`extract-voice: ${args.error}`);
      process.exit(1);
    }
    if (!args.volume && !args.list) {
      console.error("extract-voice: --volume=NN is required (or --list to see what this command would do).");
      process.exit(1);
    }
    const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
    if (!seriesDir) {
      console.error("extract-voice: no series folder — set SERIES_LOCATION or pass --series=<dir>.");
      process.exit(1);
    }
    printPlan(args, seriesDir);
    if (args.list) process.exit(0);
    validateRequiredEnv({ dryRun: args.dryRun });

    const result = await runExtractPass({
      seriesDir,
      volumeArg: args.volume,
      dryRun: args.dryRun,
      force: args.force,
      chapters: args.chapters.length ? args.chapters : null,
    });
    if (!result.ok) {
      console.log(`\nrefused: ${result.refusal.rule}`);
      console.log(`  ${result.refusal.because}`);
      if (result.refusal.useInstead) console.log(`  instead: ${result.refusal.useInstead.join(" | ")}`);
      console.log(`  fix: ${result.refusal.fix}`);
      process.exit(1);
    }
    if (result.dryRun) process.exit(0);
    if (result.refusedClaims.length) {
      console.log(`\n${result.refusedClaims.length} claim(s) were refused by the evidence rule. The notebook is complete; the record holds what verified.`);
    }
    if (result.incompleteChapters.length) {
      console.log(`\n${result.incompleteChapters.length} chapter(s) are incomplete — their answers were cut off on both paid reads: ${result.incompleteChapters.join(", ")}.`);
      console.log("The notebook is complete enough to build a reference from, and the reference will be missing whatever those answers never got to writing. Re-read a chapter with --chapter=<id>.");
      process.exit(2);
    }
    if (result.refusedClaims.length) process.exit(2);
    console.log("\nno refusals.");
    process.exit(0);
  })().catch((err) => {
    console.error(`\nextract-voice failed: ${err.message}`);
    if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
    process.exit(1);
  });
}

module.exports = {
  EXTRACTION_FILE,
  PARTIAL_PREFIX: reading.PARTIAL_PREFIX,
  PARTIAL_SCHEMA: reading.PARTIAL_SCHEMA,
  MAX_ATTEMPTS_PER_CHAPTER: reading.MAX_ATTEMPTS_PER_CHAPTER,
  EXTRACTION_RETRY_THINKING_LEVEL: reading.EXTRACTION_RETRY_THINKING_LEVEL,
  readArgs,
  registerAnnouncementLines,
  partialPath: reading.partialPath,
  segmentFingerprint: reading.segmentFingerprint,
  readPartial: reading.readPartial,
  writePartial: reading.writePartial,
  consolidateExtraction: reading.consolidateExtraction,
  scanTopLevelObjects: reading.scanTopLevelObjects,
  parseExtractionAnswer: reading.parseExtractionAnswer,
  readingReport: reading.readingReport,
  runExtractPass,
};
