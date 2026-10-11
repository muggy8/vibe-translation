#!/usr/bin/env node
/**
 * extract-voice.js — read one volume chapter by chapter and write its extraction output, and
 * nothing else.
 *
 * Why this command exists. The voice stage pays twice: the extraction pass reads the book and
 * writes a structured notebook (`character-voice-new.json`), and the author pass re-types that
 * notebook into `character-voice.md`. Measured on volume 01: the notebook cost about 1.1M tokens
 * and is healthy; the authoring cost 50M and produced a reference a grader scored 48/100, and the
 * validation pass that followed cost 62.5M. `rebuild-voice.js` already knows how to type the
 * report from the notebook without a model — but until now the notebook could only be produced by
 * running the expensive half next to it. This command unbolts the reading step from the writing
 * step.
 *
 * The route, in the order it is meant to be run:
 *
 *   node extract-voice.js  --volume=02            # read the book: N chapters, N calls
 *   node rebuild-voice.js  --volume=02 --apply    # type the reference from it, publish, seal
 *
 * What this command guarantees, in code rather than in a flag you can forget:
 *
 *   - **It is not part of a run.** No stage requires it, no prompt mentions it, it is not in
 *     `index.js`'s stage list, and `npx gulp`, `npm run pipeline` and `npm start` never reach it.
 *     The only way it happens is somebody types this command. That is why it is a command and not
 *     a mode inside the voice stage: a mode is something a normal run can fall into.
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
 *   - **It opens the volume's record through the same door the pipeline uses** — copy-forward from
 *     the previous volume's sealed record, the glossary completeness rule, and the roster fold. The
 *     reading pass is told to extract only what this chapter adds to what is already known, and
 *     "what is already known" is that record; a route that skipped it would be answering a
 *     different question than the stage answers.
 *   - **It is resumable, and resume is free.** Each chapter's answer is written to its own partial
 *     as soon as it arrives, tagged with a fingerprint of the chapter text it came from. A second
 *     invocation reuses those partials and makes no call for them. `--force` is the only way to pay
 *     for a chapter twice.
 *
 * Usage:
 *   node extract-voice.js --volume=02                        # for real
 *   node extract-voice.js --volume=02 --dry-run              # the exact prompts, no call
 *   node extract-voice.js --volume=02 --force                # re-read chapters already extracted
 *   node extract-voice.js --volume=02 --series=<dir>         # a different series folder
 *   node extract-voice.js --list                             # which folder, which chapters, no call
 *
 * Flags:
 *   --volume=NN        required (except with --list)
 *   --series=<dir>     the folder holding the volume folders (default SERIES_LOCATION)
 *   --dry-run          write the prompts a live run would send; make no model call
 *   --force            re-extract chapters that already have a usable partial
 *   --list             print what it would do and stop
 *
 * Exit codes: 0 the notebook is complete, 2 it is complete but some claims were refused,
 * 1 refused or failed.
 *
 * @module extract-voice
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { validateRequiredEnv } = require("./configs/shared");
const { transformUserPrompt, writePromptDump } = require("./utils/prompt");
const { openSeriesRun, locatePreviousVolume } = require("./utils/series-run");
const { resolveSourceBundle, chapterSegmentNote } = require("./utils/source");
const rs = require("./utils/reference-store");
const { runExtract } = require("./character-voice/stages");
const { parseVoiceQuirks } = require("./character-voice/amend");
const { buildAlreadyExtractedNote } = require("./character-voice/prompts");
const { openVoiceRecord, fileVoiceExtraction } = require("./character-voice/store");
const { extractSystemPromptFile, extractUserPromptTemplateFile } = require("./character-voice/config");
require("./types"); // JSDoc type definitions

/** The notebook the voice stage already writes under this name; this command writes the same one. */
const EXTRACTION_FILE = "character-voice-new.json";

/** One chapter's answer, kept beside the volume so a interrupted pass does not pay for it twice. */
const PARTIAL_PREFIX = "character-voice-extract-";

/** The partial's own format version, so a partial from an older shape is not silently trusted. */
const PARTIAL_SCHEMA = 1;

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, series: string|null, dryRun: boolean, force: boolean, list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { volume: null, series: null, dryRun: false, force: false, list: false, error: null };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else if (arg === "--list") out.list = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else out.error = `unrecognised flag: ${arg}`;
  }
  return out;
}


/**
 * The partial file one chapter's answer belongs in.
 *
 * @param {string} volumeDir
 * @param {string} segmentId
 * @returns {string}
 */
function partialPath(volumeDir, segmentId) {
  return path.join(volumeDir, `${PARTIAL_PREFIX}${segmentId}.json`);
}


/**
 * A fingerprint of the chapter text a partial was produced from.
 *
 * Resume is only safe if the partial belongs to the text that is there now. Content, not mtime:
 * a re-extracted chapter whose text is identical is the same chapter, and a chapter whose text
 * changed must not keep an answer that describes the old one.
 *
 * @param {string} file - Absolute path to the chapter file.
 * @returns {string} `missing` when it cannot be read — fail loud, not "unchanged".
 */
function segmentFingerprint(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (err) {
    return "missing";
  }
}


/**
 * Read one chapter's partial, and say whether it may be reused.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint - The current chapter text's fingerprint.
 * @returns {{usable: boolean, entries?: Array<Object>, file: string, because: string}}
 */
function readPartial(volumeDir, segment, fingerprint) {
  const file = partialPath(volumeDir, segment.id);
  if (!fs.existsSync(file)) return { usable: false, file, because: "no partial for this chapter yet" };

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { usable: false, file, because: `the partial is not readable JSON: ${err.message}` };
  }
  if (!parsed || parsed.schema !== PARTIAL_SCHEMA) {
    return { usable: false, file, because: `the partial is not schema ${PARTIAL_SCHEMA}` };
  }
  if (parsed.segmentId !== segment.id) {
    return { usable: false, file, because: `the partial names chapter "${parsed.segmentId}", not "${segment.id}"` };
  }
  if (!Array.isArray(parsed.entries)) {
    return { usable: false, file, because: "the partial holds no entry array" };
  }
  if (parsed.sourceSha !== fingerprint) {
    return {
      usable: false,
      file,
      because: `this chapter's text has changed since the partial was written (${String(parsed.sourceSha).slice(0, 12)}… → ${fingerprint.slice(0, 12)}…)`,
    };
  }
  return { usable: true, entries: parsed.entries, file, because: "reused: the same chapter text, already read" };
}


/**
 * Write one chapter's answer. Written to a temporary name and renamed, so a pass that dies mid-write
 * cannot leave a half-written partial that the next pass would read as an answer.
 *
 * @param {string} volumeDir
 * @param {{id: string, file: string}} segment
 * @param {string} fingerprint
 * @param {Array<Object>} entries
 * @param {string|number} installmentNumber
 * @param {{parseError?: string|null, lost?: Array<Object>, cutOff?: boolean, rawAnswer?: string}} [extra] - Kept beside the claims when the answer did not parse as a whole: what the strict parse said, which claims were dropped and what they said, and the answer itself, so a later pass can re-read it without paying for the chapter again.
 * @returns {Promise<string>} The partial's path.
 */
async function writePartial(volumeDir, segment, fingerprint, entries, installmentNumber, extra = {}) {
  const file = partialPath(volumeDir, segment.id);
  const body = JSON.stringify(
    {
      schema: PARTIAL_SCHEMA,
      volume: String(installmentNumber),
      segmentId: segment.id,
      segmentFile: segment.file,
      sourceSha: fingerprint,
      extractedAt: new Date().toISOString(),
      entries,
      ...(extra.parseError ? { parseError: extra.parseError, lostClaims: extra.lost || [], cutOff: Boolean(extra.cutOff), rawAnswer: extra.rawAnswer || "" } : {}),
    },
    null,
    2
  );
  const temp = `${file}.writing`;
  await fs.promises.writeFile(temp, body + "\n", "utf8");
  await fs.promises.rename(temp, file);
  return file;
}


/**
 * Assemble the volume's notebook from its chapter partials, in reading order.
 *
 * @param {Array<{segment: {id: string}, entries: Array<Object>}>} chapters - Already in reading order.
 * @returns {Array<Object>}
 */
function consolidateExtraction(chapters) {
  const all = [];
  for (const chapter of chapters) all.push(...chapter.entries);
  return all;
}


/**
 * Scan a JSON array for its top-level objects, string-aware.
 *
 * Why this exists and not just a second `JSON.parse`: the extraction model's answers are arrays of
 * objects, and a claim with a syntax error — a missing comma between two properties, measured on the
 * real volume 02 chapter ch2 — leaves every **other** object in that array perfectly balanced and
 * perfectly parseable. Dropping the whole chapter because one claim was malformed loses twenty claims
 * to fix one. This finds the objects; it does not repair any of them.
 *
 * @param {string} text
 * @returns {{objects: string[], closed: boolean}} The balanced top-level objects, and whether the
 *   array closed (an answer that never reached its `]` was cut off, which is a different failure).
 */
function scanTopLevelObjects(text) {
  const body = String(text || "");
  const start = body.indexOf("[");
  if (start === -1) return { objects: [], closed: false };

  const objects = [];
  let depth = 0;
  let begin = -1;
  let inString = false;
  let escaped = false;
  let closed = false;

  for (let i = start + 1; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) begin = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && begin !== -1) {
        objects.push(body.slice(begin, i + 1));
        begin = -1;
      }
      continue;
    }
    if (ch === "]" && depth === 0) { closed = true; break; }
  }

  return { objects, closed };
}


/**
 * Read one chapter's answer as extraction entries.
 *
 * The strict parse is tried first, and a well-formed answer takes it and nothing else. When it
 * fails, the answer is read object by object: each object that parses on its own is kept, each one
 * that does not is dropped **and named with its raw text kept in the partial**, so a lost claim is
 * evidence somebody can read rather than a hole in a file. Nothing is invented and nothing is
 * repaired — the evidence rule still has to find every recovered claim's quote in this volume's text,
 * exactly like a claim that arrived in one piece.
 *
 * @param {string} output - The raw answer.
 * @returns {{entries: Array<Object>, recovered: boolean, lost: Array<{because: string, raw: string}>, cutOff: boolean, error: string|null}}
 */
function parseExtractionAnswer(output) {
  try {
    return { entries: parseVoiceQuirks(output), recovered: false, lost: [], cutOff: false, error: null };
  } catch (err) {
    const { objects, closed } = scanTopLevelObjects(output);
    /** @type {Array<Object>} */
    const entries = [];
    /** @type {Array<{because: string, raw: string}>} */
    const lost = [];
    for (const raw of objects) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && typeof parsed.type === "string") entries.push(parsed);
        else lost.push({ because: "the claim carries no `type`, so it is not a claim", raw: raw.slice(0, 500) });
      } catch (inner) {
        lost.push({ because: inner.message, raw: raw.slice(0, 500) });
      }
    }
    return { entries, recovered: true, lost, cutOff: !closed, error: err.message };
  }
}


/**
 * Read one volume chapter by chapter and write its notebook.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {string} opts.volumeArg - The `--volume` value, resolved through the plan of record.
 * @param {boolean} [opts.dryRun] - Dump the prompts, call nothing.
 * @param {boolean} [opts.force] - Re-read chapters that already have a usable partial.
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, refusal: Object|null, volume: string, folder: string, chapters: Array<Object>, entries: number, refusedClaims: Array<Object>, record: Object|null, extractionFile: string|null, dryRun: boolean}>}
 */
async function runExtractPass({ seriesDir, volumeArg, dryRun = false, force = false, log = console.log }) {
  const systemPrompt = await fs.promises.readFile(extractSystemPromptFile, "utf8");
  const template = await fs.promises.readFile(extractUserPromptTemplateFile, "utf8");

  const { runSettings, folders, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun, volumeArg });
  if (volumes.length !== 1) {
    return {
      ok: false,
      refusal: { rule: "one-volume-only", because: `this command reads one volume per invocation; --volume=${volumeArg || "<NN>"} selected ${volumes.length}.`, fix: 'pass exactly one volume, e.g. --volume=02' },
      volume: String(volumeArg), folder: "", chapters: [], entries: 0, refusedClaims: [], record: null, extractionFile: null, dryRun,
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
    return { ok: false, refusal: { rule: "volume-folder-missing", because: `${volumeDir} is not there.`, fix: "check --series and the plan of record." }, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], record: null, extractionFile: null, dryRun };
  }

  // The same source resolution the stage uses: the extracted chapter files the evidence rule cites.
  const bundle = await resolveSourceBundle({ seriesDir, volume: volumeEntry, volumeDir, force: false });
  const segments = bundle.segments && bundle.segments.length ? bundle.segments : [];
  log(`  chapters: ${segments.length} segment(s), ${bundle.wholeChars} characters whole — read one at a time`);

  const values = {
    INSTALLMENT_NUMBER: installmentNumber,
    SOURCE_NAME: runSettings.seriesName,
    SOURCE_LANGUAGE: runSettings.sourceLanguage,
    TARGET_LANGUAGE: runSettings.targetLanguage,
  };

  /** The ctx `character-voice/stages.js`'s own extraction pass reads. Built the way the stage builds it. */
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
    extractSystemPrompt: systemPrompt,
    refStore: null,
  };

  if (dryRun) {
    const sections = [
      { title: "One-shot — extraction system prompt", prompt: ctx.extractSystemPrompt },
      { title: "One-shot — extraction user prompt", prompt: ctx.extractPrompt },
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
      const partial = readPartial(volumeDir, seg, segmentFingerprint(path.join(volumeDir, seg.file)));
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
    return { ok: true, refusal: null, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], record: null, extractionFile: null, dryRun: true };
  }

  // The volume's record, opened through the pipeline's own door: copy-forward from the previous
  // volume's sealed record, the glossary completeness rule, the roster fold. Not behind
  // VOICE_STORE_VALIDATORS — a guard with an env knob on it is not a guard (AGENTS.md rule 3).
  const attempt = openVoiceRecord(ctx, previousInstallmentNumber);
  if (!attempt.ok) {
    return { ok: false, refusal: { rule: "record-refused", because: attempt.error, fix: "see the refusal above." }, volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], record: null, extractionFile: null, dryRun };
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
        volume: String(installmentNumber), folder: folderName, chapters: [], entries: 0, refusedClaims: [], record: null, extractionFile: null, dryRun,
      };
    }

    const carried = attempt.opened.carried;
    if (carried) {
      const counts = carried.provenance.copiedRows;
      log(`  record:  carried forward from volume ${previousInstallmentNumber} (${counts.facts} facts, ${counts.cast} characters)`);
    } else if (attempt.opened.toppedUp && attempt.opened.toppedUp.total > 0) {
      log(`  record:  topped up from volume ${previousInstallmentNumber} (${attempt.opened.toppedUp.total} row(s) this record was missing)`);
    }
    const backfill = attempt.opened.glossaryBackfill;
    if (backfill && backfill.ran) {
      log(`  record:  read this volume's glossary.md into itself — ${backfill.imported} new row(s), ${backfill.carried} carried, ${backfill.refused.length} refused, ${backfill.castRegistered} roster entr(ies)`);
    }
    for (const line of rs.rosterReconciliationLog(installmentNumber, attempt.opened.roster)) log(line);

    /** @type {Array<{segment: Object, entries: Array<Object>, reused: boolean, because: string}>} */
    const chapters = [];
    for (let si = 0; si < segments.length; si++) {
      const segment = segments[si];
      const segPath = path.join(volumeDir, segment.file);
      const fingerprint = segmentFingerprint(segPath);

      if (!force) {
        const partial = readPartial(volumeDir, segment, fingerprint);
        if (partial.usable) {
          log(`  chapter ${segment.id}: reused (${partial.entries.length} claim(s)) — ${partial.because}`);
          chapters.push({ segment, entries: partial.entries, reused: true, because: partial.because });
          continue;
        }
        if (partial.because !== "no partial for this chapter yet") log(`  chapter ${segment.id}: re-reading — ${partial.because}`);
      }

      // The cumulative reference this chapter is shown, and the only one that exists in this route:
      // the previous volume's published reference, held constant for every chapter. The stage shows
      // chapter 4 the document chapter 3's author pass wrote; there is no such document here, and
      // inventing one is the half this command exists to stop paying for.
      const already = chapters.flatMap((c) => c.entries);
      const note = buildAlreadyExtractedNote({
        installmentNumber,
        segmentsTotal: segments.length,
        doneSegments: chapters.map((c) => c.segment.id),
        entries: already,
      });

      let output = "";
      try {
        output = await runExtract(ctx, segment, si, { stateFile: ctx.previousVoiceRefFile, extraNote: note });
      } catch (err) {
        log(`  chapter ${segment.id}: extraction FAILED: ${err.message}`);
        return {
          ok: false,
          refusal: { rule: "chapter-extraction-failed", because: `chapter ${segment.id}: ${err.message}`, fix: "run this command again — the chapters already read are kept and are not paid for twice." },
          volume: String(installmentNumber), folder: folderName, chapters, entries: consolidateExtraction(chapters).length, refusedClaims: [], record: attempt.opened, extractionFile: null, dryRun,
        };
      }

      const parsed = parseExtractionAnswer(output);
      if (parsed.entries.length === 0) {
        log(`  chapter ${segment.id}: the answer yielded no claims at all (${parsed.error}) — nothing was written for it.`);
        return {
          ok: false,
          refusal: {
            rule: "chapter-extraction-unparseable",
            because: `chapter ${segment.id}: ${parsed.error}${parsed.cutOff ? " — and the answer never reached its closing bracket, so it was cut off, not merely malformed" : ""}`,
            fix: "run this command again; the chapters already read are kept and are not paid for twice.",
          },
          volume: String(installmentNumber), folder: folderName, chapters, entries: consolidateExtraction(chapters).length, refusedClaims: [], record: attempt.opened, extractionFile: null, dryRun,
        };
      }
      if (parsed.recovered) {
        log(`  chapter ${segment.id}: the answer was not valid JSON as a whole (${parsed.error}).`);
        log(`    recovered ${parsed.entries.length} claim(s) individually; ${parsed.lost.length} could not be read${parsed.cutOff ? " and the answer was cut off before its closing bracket" : ""}.`);
        for (const item of parsed.lost.slice(0, 10)) log(`    lost: ${item.because} — ${item.raw.replace(/\s+/g, " ").slice(0, 160)}`);
      }

      const file = await writePartial(volumeDir, segment, fingerprint, parsed.entries, installmentNumber, {
        parseError: parsed.recovered ? parsed.error : null,
        lost: parsed.lost,
        cutOff: parsed.cutOff,
        rawAnswer: parsed.recovered ? output : undefined,
      });
      log(`  chapter ${segment.id}: ${parsed.entries.length} claim(s) → ${path.basename(file)}${parsed.recovered ? " (recovered claim by claim)" : ""}`);
      chapters.push({ segment, entries: parsed.entries, reused: false, because: "read this run", lostClaims: parsed.lost.length });
    }

    const entries = consolidateExtraction(chapters);
    const extractionFile = path.join(volumeDir, EXTRACTION_FILE);
    const temp = `${extractionFile}.writing`;
    await fs.promises.writeFile(temp, JSON.stringify(entries, null, 2) + "\n", "utf8");
    await fs.promises.rename(temp, extractionFile);
    const called = chapters.filter((c) => !c.reused).length;
    log(`\nnotebook`);
    log(`  ${EXTRACTION_FILE}: ${entries.length} claim(s) from ${chapters.length} chapter(s) — ${called} model call(s), ${chapters.length - called} reused`);
    log(`  written: ${extractionFile}`);

    const voice = fileVoiceExtraction(ctx, entries) || { importedCount: 0, carried: [], refused: [], characters: 0, povCount: 0, unresolved: [] };
    log(`  record filed: ${voice.importedCount} claim(s) about ${voice.characters} character(s), ${voice.povCount} POV claim(s), ${voice.carried.length} already filed`);
    log(`  refused:      ${voice.refused.length} for want of a line this volume's text prints`);
    for (const item of voice.refused.slice(0, 40)) log(`    ${item.character || "(no character)"} ${item.label || item.kind}: ${item.because}`);
    if (voice.unresolved && voice.unresolved.length) {
      log(`  names the roster does not carry: ${voice.unresolved.map((u) => `${u.name} → filed as ${u.key}`).join(", ")}`);
    }

    return {
      ok: true,
      refusal: null,
      volume: String(installmentNumber),
      folder: folderName,
      chapters: chapters.map((c) => ({ id: c.segment.id, claims: c.entries.length, reused: c.reused })),
      entries: entries.length,
      refusedClaims: voice.refused,
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

    const result = await runExtractPass({ seriesDir, volumeArg: args.volume, dryRun: args.dryRun, force: args.force });
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
      process.exit(2);
    }
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
  PARTIAL_PREFIX,
  PARTIAL_SCHEMA,
  readArgs,
  partialPath,
  segmentFingerprint,
  readPartial,
  writePartial,
  consolidateExtraction,
  scanTopLevelObjects,
  parseExtractionAnswer,
  runExtractPass,
};
