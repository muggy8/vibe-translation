#!/usr/bin/env node
/**
 * attribute-voice.js — ask, once per doubted roster entry, who is speaking the words a claim quotes.
 *
 * There are two halves to this, and only one of them costs anything.
 *
 * **The deterministic half** (`utils/reference-store/attribution.js`) reads the volume's own record and
 * says which roster entries are in doubt: an entry this volume filed claims under, that this volume's own
 * text does not measure as present. It writes nothing and calls no model. `--check` is that half alone, so
 * it can be run against any volume in the series to see what the record already knows.
 *
 * **The reading half** (`character-voice/detective.js`) is the only part that asks the model anything. It
 * is bounded — one call per doubted entry, at most `DETECTIVE_MAX_GROUPS` entries per run, at most
 * `DETECTIVE_MAX_STEPS` tool calls each, and a prompt-token budget after which the remaining entries are
 * reported as unanswered instead of paid for. The agent may read, in that volume's folder only; it is not
 * offered a write tool at all.
 *
 * What an answer does, and what it cannot do. The answer is filed in `attribution_answers`, so the next run
 * can tell "nobody asked" from "somebody asked and agreed" and does not pay for the same reading twice. An
 * answer that **agrees** with the record closes the question. An answer that **disagrees** — the words belong
 * to somebody else, or belong to the narration — opens a `challenge_fact` row per claim, owned by this
 * volume, each with its own quote checked against the book. The claim the reference already published is
 * **not edited and not moved**: it is marked `disputed` and stays exactly where it is until somebody closes
 * the dispute with `resolve_challenge`. A model that could settle a published claim by answering a question
 * is a model that rewrites published history, so this command does not let it.
 *
 * "The narrator said it" is a real answer and gets its own shape. It files the challenger with **no roster
 * entry at all** (`key = null`, `extracted_as = "narrator"`), which is the record's existing shape for a
 * claim whose subject it refuses to invent. The coverage rule counts rows in `cast`, and a narrator answer
 * creates none, so the narration is never asked to be a character.
 *
 * What this command does NOT do: it does not rewrite `character-voice.md` or `pov-map.md`, it does not seal
 * or unseal anything, it does not touch `presence.js` or the evidence matcher, and it does not file a
 * `cast_alias` row even when the answer is "the name is printed in a spelling this record cannot see" — an
 * alias changes how every later volume measures that character, which is a decision for the owner of the
 * series, not an inference from one scene. The report names the door instead of walking through it.
 *
 * Usage:
 *   node attribute-voice.js --volume=02 --check        # what the record already knows; writes nothing
 *   node attribute-voice.js --volume=02                # read the scenes, file the answers
 *   node attribute-voice.js --volume=02 --dry-run      # the exact request, no model call, no writes
 *   node attribute-voice.js --answers --volume=02      # the answers this record holds, and nothing else
 *   node attribute-voice.js --list
 *
 * Flags:
 *   --volume=NN      required (except with --list)
 *   --check          the deterministic pass only: no model call, no writes, no report file
 *   --answers        print this volume's filed answers and stop
 *   --dry-run        build the request and dump it to the run's `.dry-run/` folder; call nothing
 *   --series=<dir>   the folder holding the volume folders (default SERIES_LOCATION)
 *   --list           print which folder a --volume would name, and stop
 *
 * Exit codes: 0 nothing is in doubt, or every doubt was answered; 1 a doubt is still open, or an answer was
 * refused. A doubt that was answered by opening a dispute exits 1 on purpose: the dispute is not closed.
 *
 * @module attribute-voice
 */

const fs = require("fs").promises;
const path = require("path");

const { chosenSeriesLocation, loadEnv } = require("./configs/env-defaults");
const { dryRunDir } = require("./configs/run-state");
const { openSeriesRun } = require("./utils/series-run");
const { writePromptDump } = require("./utils/prompt");
const detective = require("./character-voice/detective");
const rs = require("./utils/reference-store");
require("./types"); // JSDoc type definitions

/** The notebook this command writes into the volume's own folder. */
const ATTRIBUTION_REPORT_FILE = "character-voice-attribution.md";

/**
 * Parse this command's flags.
 *
 * @param {string[]} argv
 * @returns {{volume: string|null, check: boolean, answers: boolean, dryRun: boolean, series: string|null, list: boolean, error: string|null}}
 */
function readArgs(argv) {
  const out = { volume: null, check: false, answers: false, dryRun: false, series: null, list: false, error: null };
  for (const arg of argv) {
    if (arg === "--list") out.list = true;
    else if (arg === "--check") out.check = true;
    else if (arg === "--answers") out.answers = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg.startsWith("--volume=")) out.volume = arg.slice("--volume=".length);
    else if (arg.startsWith("--series=")) out.series = arg.slice("--series=".length);
    else out.error = `unrecognised flag: ${arg}`;
  }
  return out;
}

/**
 * One claim, as a line of the report.
 *
 * @param {Object} claim - A row from `claimsFiledUnderAtVolume`.
 * @returns {string}
 */
function claimLine(claim) {
  const body = String(claim.body || "").replace(/\s+/g, " ").trim();
  const where = claim.chapter ? `${claim.chapter}:${claim.line}` : "no citation";
  const published = claim.sourceStage === "extract" ? "extraction candidate" : "published claim";
  return `- \`${claim.id}\` ${claim.aspect} (${published}) at ${where} — ${body.length > 220 ? `${body.slice(0, 220)}…` : body}`;
}

/**
 * The deterministic account of one volume's doubts, as markdown.
 *
 * Written from the record's own query results. Nothing in it is a model's summary of anything.
 *
 * @param {Object} doubts - From `attributionDoubts`.
 * @param {Object} [opts]
 * @param {Array<Object>} [opts.results] - What this run's detective calls produced, if any.
 * @param {Array<Object>} [opts.skipped] - Groups this run did not ask about.
 * @param {Object} [opts.usage] - The token counts this run spent.
 * @returns {string}
 */
function renderReport(doubts, { results = [], skipped = [], usage = null } = {}) {
  const out = [
    "# Who is speaking — the attribution account for this volume",
    "",
    "Written by code from this volume's reference record (`series.db`), and from the reading pass this",
    "command ran. Every number in it is a query result.",
    "",
    "A claim does two jobs: it says **who it is about** (the roster entry its bullet is filed under) and it",
    "quotes **words somebody said**. This file is about the second job. The record cannot answer it from a",
    "rule — the obvious rule (a name inside a quote is the speaker) was measured against both real records",
    "and is wrong on every example it produced, because the name inside a quote is usually the person being",
    "*spoken to*. So the code decides only **when the answer is in doubt**, and the doubt is answered by",
    "reading the scene.",
    "",
    "## What the record asked",
    "",
    `The question: a roster entry this volume filed claims under, that this volume's own text does not`,
    `measure as present.`,
    "",
    `**${doubts.groups.length} entr(ies) in doubt** in volume ${doubts.volume}.`,
    ""
  ];

  if (!doubts.asked) {
    out.push(`**Not asked.** ${doubts.because}`, "");
    return out.join("\n");
  }

  for (const group of doubts.groups) {
    const aids = group.readingAids || {};
    out.push(`### ${group.key} (${group.display})`);
    out.push("");
    out.push(
      `This volume filed **${group.claimCount} claim(s)** under this entry ` +
        `(${group.publishedClaims} of them published claims, ${group.candidateClaims} extraction candidates), ` +
        `and ${group.speechClaims} of them quote words.`
    );
    out.push("");
    if (group.presence) {
      out.push(
        `- presence in volume ${group.volume}'s text: present=${group.presence.present}, ` +
          `${group.presence.chapters} chapter(s), ${group.presence.matches} match(es)`
      );
    } else {
      out.push(`- this record has no presence row for this entry at all`);
    }
    if (aids.found) {
      out.push(
        `- the name **is** printed in this volume's text, with reading aids between its kanji: ` +
          aids.hits.slice(0, 5).map((h) => `「${h.span}」 at ${h.chapter}:${h.line}`).join(", ") +
          ` (looked for as ${aids.kanjiNames.join(", ")}: its kanji in order, with only kana between them, ` +
          `at most ${rs.READING_AID_MAX_GAP} kana wide)`
      );
      out.push(
        `- the shortest Han-character run in this entry's names is ${aids.kanjiCount}, and the store's one ` +
          `matching rule needs ${rs.SKELETON_MIN_CHARS} or more, so this name is invisible to it. That is a ` +
          `blind spot in the measurement. The measurement is deliberately not widened for it: the coverage ` +
          `rule and the copy-forward guard are built on that one rule answering the same question everywhere, ` +
          `and \`cast_alias(${group.key}, <that spelling>, <reason>)\` is the door that closes this case properly.`
      );
    } else if (aids.skipped && aids.skipped.length) {
      out.push(`- no reading-aid spelling could be looked for: ${aids.skipped.join(", ")} has too few kanji to order`);
    } else {
      out.push(`- not printed with reading aids between its kanji either, so on this record's evidence the name really is absent`);
    }
    out.push("");
    out.push("The claims:");
    out.push("");
    for (const claim of group.claims) out.push(claimLine(claim));
    out.push("");
    const answer = group.answer;
    if (answer) {
      out.push(
        `**Asked and answered:** ${answer.answer}${answer.speaker ? ` → ${answer.speaker}` : ""} — ${answer.reason}`
      );
      out.push("");
      out.push(
        `Filed by volume ${answer.asked_by_volume} at the ${answer.asked_by_stage} step, on ${answer.asked_at}.`
      );
      out.push("");
      for (const item of answer.evidence || []) out.push(`- evidence: ${item.chapter}:${item.line} — "${item.quote}"`);
      out.push("");
    } else {
      out.push(`**Nobody has answered this yet.**`);
      out.push("");
    }
  }

  if (results.length || skipped.length) {
    out.push("## What this run did");
    out.push("");
    out.push(
      `One reading pass per doubted entry, at most ${detective.DETECTIVE_MAX_GROUPS} per run, at most ` +
        `${detective.DETECTIVE_MAX_STEPS} read-only tool calls each, and a budget of ` +
        `${detective.DETECTIVE_TOKEN_BUDGET} prompt tokens for the whole run.`
    );
    out.push("");
    for (const r of results) {
      if (r.ok) {
        out.push(
          `- **${r.key}** — answered \`${r.answer}\`${r.speaker ? ` → ${r.speaker}` : ""}: ${r.reason}` +
            `${r.challenges && r.challenges.length ? ` (${r.challenges.length} challenge row(s) opened)` : " (no challenge opened)"}`
        );
      } else {
        out.push(`- **${r.key}** — NOT filed: ${r.because}`);
      }
    }
    for (const s of skipped) out.push(`- **${s.key}** — not asked: ${s.because}`);
    out.push("");
    if (usage) {
      out.push(
        `Tokens this run spent: ${usage.promptTokens} prompt + ${usage.completionTokens} completion = ` +
          `${usage.totalTokens} total, over ${usage.calls} model call(s).`
      );
      out.push("");
    }
  }

  out.push("## What this command did not do");
  out.push("");
  out.push("- It did not edit, move, or delete a claim that this record has already published. A sealed row is never edited.");
  out.push("- It did not rewrite `character-voice.md` or `pov-map.md`. An answer that disagrees is recorded as an open dispute, and the published reference keeps saying what it says until somebody closes it with `resolve_challenge`.");
  out.push("- It did not seal or unseal anything, and it did not file a `cast_alias` row.");
  out.push("- It did not widen how this record matches a name. The reading-aid probe above is used for this question only.");
  out.push("");
  return out.join("\n");
}

/**
 * Print the doubts to stdout, in the shape a terminal reader wants.
 *
 * @param {Object} doubts - From `attributionDoubts`.
 * @param {(line: string) => void} log
 * @returns {void}
 */
function printDoubts(doubts, log) {
  if (!doubts.asked) {
    log(`  NOT ASKED — ${doubts.because}`);
    return;
  }
  if (doubts.groups.length === 0) {
    log(`  nothing in doubt: every roster entry this volume filed claims under is measured present in its own text.`);
    return;
  }
  for (const group of doubts.groups) {
    const aids = group.readingAids || {};
    log(`  ${group.key} (${group.display}) — ${group.claimCount} claim(s), ${group.speechClaims} quoting words`);
    log(`    presence: ${group.presence ? `present=${group.presence.present} in ${group.presence.chapters} chapter(s)` : "no presence row"}`);
    if (aids.found) log(`    printed as: ${aids.hits.slice(0, 3).map((h) => `「${h.span}」 ${h.chapter}:${h.line}`).join(", ")}`);
    log(`    claims:   ${group.claims.map((c) => `${c.aspect} ${c.chapter}:${c.line}`).join(", ")}`);
    if (group.answer) log(`    answer:   ${group.answer.answer}${group.answer.speaker ? ` → ${group.answer.speaker}` : ""} — ${group.answer.reason}`);
    else log(`    answer:   none`);
  }
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
  const { runSettings, volumes, volumeByFolder } = await openSeriesRun({ seriesDir, dryRun: true, volumeArg: args.volume });

  if (args.list) {
    log(`attribute-voice — ${runSettings.seriesDir}`);
    for (const folder of volumes) {
      const entry = volumeByFolder.get(folder);
      log(`  volume ${String(entry.installmentNumber).padStart(2, "0")}  ${folder}`);
    }
    return 0;
  }

  if (volumes.length !== 1) {
    log(`REFUSED — one-volume-only`);
    log(`  this command answers one volume's doubts per invocation; --volume=${args.volume || "<NN>"} selected ${volumes.length}.`);
    log(`  fix: pass exactly one volume, e.g. --volume=02`);
    return 1;
  }

  const folderName = volumes[0];
  const volume = volumeByFolder.get(folderName).installmentNumber;
  const store = rs.openReferenceStore({ volume, folder: folderName, seriesDir, stage: "attribution", create: false });

  try {
    const volumeDir = rs.attributionVolumeDir(store, volume);

    if (args.answers) {
      const answers = store.attributionAnswers();
      log(`attribution answers — volume ${volume} (${folderName})`);
      if (!answers.length) {
        log("  none. This record has never been asked who is speaking.");
        return 0;
      }
      for (const row of answers) {
        log(`  volume ${row.volume} / ${row.key}: ${row.answer}${row.speaker ? ` → ${row.speaker}` : ""}`);
        log(`    reason: ${row.reason}`);
        log(`    asked by: volume ${row.askedByVolume} at the ${row.askedByStage} step, ${row.askedAt}`);
        log(`    covers: ${row.claimIds.length} claim(s)`);
        for (const item of row.evidence) log(`    evidence: ${item.chapter}:${item.line} — "${item.quote}"`);
      }
      return 0;
    }

    log(`\nattribute-voice — volume ${volume} (${folderName})`);
    log(`  record:  ${store.file}`);
    log(`  reading: ${volumeDir || "(the volume folder could not be resolved)"}`);

    const doubts = store.attributionDoubts({ volume });
    log(`\n  in doubt: ${doubts.asked ? doubts.groups.length : "not asked"}`);
    printDoubts(doubts, log);

    if (args.check) {
      const findings = store.attributionFindings({ volume });
      log(`\n  as findings:`);
      if (!findings.length) log("    none");
      for (const f of findings) log(`    ${f.severity} ${f.kind}`);
      log(`\n  --check writes nothing and calls nothing.`);
      return findings.some((f) => f.severity === "HIGH") ? 1 : 0;
    }

    const unanswered = doubts.groups.filter((group) => !group.answer);
    /**
     * Write the volume's notebook from the record's current state.
     *
     * Written on a run that asked nothing too: the notebook is a rendering of what the record holds, and a
     * re-run that finds every doubt already answered should still leave the folder showing that, rather than
     * leaving last run's version behind.
     *
     * @param {Object|null} usage
     * @param {Array<Object>} [results]
     * @param {Array<Object>} [skipped]
     * @returns {Promise<void>}
     */
    const writeNotebook = async ({ usage, results = [], skipped = [] }) => {
      if (!volumeDir) return;
      const after = store.attributionDoubts({ volume });
      const body = renderReport(after, { results, skipped, usage });
      await fs.writeFile(path.join(volumeDir, ATTRIBUTION_REPORT_FILE), body, "utf-8");
      log(`\n  notebook: ${path.join(volumeDir, ATTRIBUTION_REPORT_FILE)}`);
    };

    if (doubts.asked && unanswered.length === 0) {
      log(`\n  nothing to ask: every doubt this volume holds already has an answer in the record.`);
      await writeNotebook({ usage: null });
      const findings = store.attributionFindings({ volume });
      const high = findings.filter((f) => f.severity === "HIGH");
      log(`\n  attribution findings now:`);
      if (!findings.length) log("    none");
      for (const f of findings) log(`    ${f.severity} ${f.kind}`);
      return high.length ? 1 : 0;
    }

    if (args.dryRun) {
      const sections = [];
      for (const group of unanswered.slice(0, detective.DETECTIVE_MAX_GROUPS)) {
        sections.push({ title: `attribution-detective ${volume} ${group.key}`, prompt: detective.buildDetectivePrompt(store, group) });
      }
      const dir = dryRunDir();
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `character-voice-attribution-${volume}.md`);
      const body =
        `# character-voice attribution — volume ${volume} prompt dump (--dry-run)\n\n` +
        `Model calls: ${sections.length}. Caps: ${detective.DETECTIVE_MAX_GROUPS} group(s) per run, ` +
        `${detective.DETECTIVE_MAX_STEPS} read-only tool calls each, ${detective.DETECTIVE_TOKEN_BUDGET} prompt tokens total.\n\n` +
        sections.map((s) => `## ${s.title}\n\n${s.prompt}\n`).join("");
      await fs.writeFile(file, body, "utf-8");
      log(`\n  --dry-run: ${sections.length} request(s) written to ${file}. No model call, no row written.`);
      if (unanswered.length > sections.length) {
        log(`  ${unanswered.length - sections.length} group(s) would not be asked: this run asks at most ${detective.DETECTIVE_MAX_GROUPS}.`);
      }
      return 0;
    }

    const outcome = await detective.resolveAttributionDoubts({ store, volume, volumeDir, log });

    await writeNotebook({
      results: outcome.results,
      skipped: outcome.skipped,
      usage: {
        calls: outcome.asked,
        promptTokens: outcome.promptTokens,
        completionTokens: outcome.completionTokens,
        totalTokens: outcome.totalTokens,
      },
    });

    const findings = store.attributionFindings({ volume });
    const high = findings.filter((f) => f.severity === "HIGH");
    log(`\n  attribution findings now:`);
    if (!findings.length) log("    none");
    for (const f of findings) log(`    ${f.severity} ${f.kind}`);
    log(`  tokens: ${outcome.promptTokens} prompt + ${outcome.completionTokens} completion = ${outcome.totalTokens} total, ${outcome.asked} call(s).`);
    if (outcome.error) log(`  error: ${outcome.error}`);
    if (high.length) {
      log(`\n  an open dispute is not a closed one: the published reference still attributes these words to`);
      log(`  the entry it filed them under, and resolve_challenge(id, "uphold" | "accept") is what decides it.`);
    }
    return high.length ? 1 : 0;
  } finally {
    store.close();
  }
}

if (require.main === module) {
  const args = readArgs(process.argv.slice(2));
  if (args.error) {
    console.log(`REFUSED — ${args.error}`);
    console.log(`  see the header of attribute-voice.js for the flags this command takes.`);
    process.exit(1);
  }
  if (!args.volume && !args.list) {
    console.log("REFUSED — attribute-voice.js needs --volume=NN (or --list).");
    process.exit(1);
  }
  loadEnv();
  const seriesDir = path.resolve(args.series || chosenSeriesLocation() || "");
  main({ args, seriesDir })
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("attribute-voice failed:", err);
      process.exit(1);
    });
}

module.exports = { ATTRIBUTION_REPORT_FILE, readArgs, renderReport, printDoubts, main };
