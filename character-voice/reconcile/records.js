/**
 * character-voice/reconcile/records.js — where the closing cast reconciliation writes, and the two shapes
 * it writes: the machine twin and the one a person reads.
 *
 * The pass asks the record a question and gets an answer. An answer nobody can re-read is an answer nobody
 * can argue with, so it is written twice: `cast-reconciliation.json` (every bucket, every character, every
 * signal, so a later run can diff them) and `cast-reconciliation.md` (the same split in the order a reader
 * needs it, with the two halves of the rule it could not run named in the body).
 *
 * ## Where they live, and why not in a volume folder
 *
 * In the run's own records (`<series>/.run/postmortem/`), which is where the `extract` step's reports and
 * the glossary settlement's decisions already live. They are the run's memory, not a deliverable: they are
 * committed with the books so another machine can see what this series' cast looked like at the end of the
 * run, and they are not in a volume folder, where the acceptance gate grades three named files and a fourth
 * section shape is a change to what it is grading (plan 06 §11).
 *
 * They are deliberately **not** declared in `utils/artifacts/preproduction.js`, exactly as the settlement's
 * two records are not: the post-mortem does not check them, so a reconciliation that wrote nothing cannot
 * reach the resume triage or the halt gate. That is the same hole AGENTS.md gotcha 138 records, and closing
 * it is an owner decision, not a slice detail.
 *
 * ## Why nothing here is written into a published artifact
 *
 * `renderRebuiltVoice` gives a character a section only when the record holds a current claim about them,
 * so a bucket-3 character has no section in `character-voice.md` at all. Adding a "named, never recorded"
 * line to that file is a change to a published artifact's section shape, to what the grader is shown, and —
 * because the store reads that file back through `parseVoiceMarkdown` — to how a published claim's body is
 * re-imported (gotcha 157: a non-bullet line after the first bullet is glued onto that bullet). This pass
 * publishes to its own two files and leaves the artifact alone; the question of whether the named absence
 * should reach the reference is written down rather than decided here.
 *
 * @module character-voice/reconcile/records
 */

const fs = require("fs");
const path = require("path");

const { configuredDir, RUN_DIR_NAME, RUN_STATE_SUBDIRS } = require("../../configs/run-state");
const { REFERENCE_STORE_FILE_NAME } = require("../../utils/reference-store");
const { NOT_FUNGIBLE_MIN_VOLUMES, SPEAKER_TEST_NOT_RUN, BLIND_SPOT } = require("./fungibility");

require("../../types"); // JSDoc type definitions

/** The machine twin of the split. */
const RECONCILIATION_JSON_FILE = "cast-reconciliation.json";
/** The same split, for a person. */
const RECONCILIATION_MD_FILE = "cast-reconciliation.md";

/**
 * The record's own shape version. Bumped only when an existing entry would be read wrongly.
 * @type {number}
 */
const RECONCILIATION_RECORD_SCHEMA = 1;

/**
 * How many names one section prints before it starts counting the rest instead.
 *
 * A constant with no environment knob. It is a *print* bound, not a decision bound: every list's total is
 * stated in the section's own sentence, and the remainder is named by count, so the cap cannot shrink what
 * the file says — only how much of it is spelled out.
 *
 * @type {number}
 */
const RECONCILIATION_MAX_NAMES_LISTED = 40;

/**
 * How many volumes one dossier names before counting the rest.
 *
 * @type {number}
 */
const RECONCILIATION_MAX_VOLUMES_NAMED = 12;

/**
 * Where the pass writes, under a series.
 *
 * `POSTMORTEM_DIR` wins outright, exactly as the ledger, the tickets, the extraction reports and the
 * settlement's decisions resolve themselves; otherwise it is the run's records folder beside this series.
 * The series is passed in rather than read from the environment, so a test pointed at a fixture cannot end
 * up writing next to the books.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {{dir: string, json: string, markdown: string}}
 */
function reconciliationRecordPaths(seriesDir) {
  const dir = configuredDir("POSTMORTEM_DIR") || path.join(String(seriesDir), RUN_DIR_NAME, RUN_STATE_SUBDIRS.postmortem);
  return { dir, json: path.join(dir, RECONCILIATION_JSON_FILE), markdown: path.join(dir, RECONCILIATION_MD_FILE) };
}

/**
 * One character, in the shape the JSON record stores.
 *
 * Every field is a row the record already held. Nothing here is inferred, judged, or asked of a model.
 *
 * @param {Object} row - A bucket row from `buckets.js`, already classified by `fungibility.js`.
 * @param {string} bucket - `voiced` | `never-seen` | `on-page-unrecorded`.
 * @param {Object|null} [decision] - The fungibility decision, for the third bucket only.
 * @returns {Object}
 */
function reconciliationEntry(row, bucket, decision = null) {
  return {
    key: row.key,
    display: row.display,
    bucket,
    firstSeenVolume: row.firstSeenVolume,
    recordedClaims: row.recordedClaims,
    extractionClaims: row.extractionClaims,
    volumesPresent: row.volumesPresent,
    volumesMeasured: row.volumesMeasured,
    chaptersTotal: row.chaptersTotal,
    perVolume: row.perVolume,
    rosterKeys: row.identityKeys,
    fungible: decision ? decision.fungible : null,
    volumesSeen: decision ? decision.volumesSeen : null,
    rosterVolumesHeld: decision ? decision.rosterVolumesHeld : null,
    because: decision ? decision.because : null,
  };
}

/**
 * Print a list of names without letting a long one bury the count it belongs to.
 *
 * @param {Array<Object>} rows - Bucket rows.
 * @param {(row: Object) => string} line - The line for one row.
 * @returns {string[]} The lines, ending with the named remainder when the cap bit.
 */
function nameLines(rows, line) {
  const shown = rows.slice(0, RECONCILIATION_MAX_NAMES_LISTED);
  const out = shown.map(line);
  const left = rows.length - shown.length;
  if (left > 0) out.push(`_… ${left} more named in \`cast-reconciliation.json\` and not spelled out here._`);
  return out;
}

/**
 * The dossier one investigated character gets: where the book prints them, what proved it, and what the
 * record holds instead.
 *
 * This is the whole of what "investigated" means in this pass, and it is worth saying plainly: it is a
 * deterministic look at the record's own measurements, at 0 model calls. It is not a diagnostics turn, it
 * opens no ticket, and it asks nothing of a model — plan 06 §9 forbids a model judging importance, and the
 * measurement that would justify one does not exist.
 *
 * @param {Object} row - A bucket-3 row with its {@link classifyFungibility} decision attached as `decision`.
 * @returns {string[]}
 */
function dossierLines(row) {
  const out = [];
  out.push(`### ${row.display} (\`${row.key}\`)`);
  out.push(`- first on the roster in: volume ${row.firstSeenVolume === null ? "not recorded" : row.firstSeenVolume}`);
  const volumes = row.volumesPresent.slice(0, RECONCILIATION_MAX_VOLUMES_NAMED);
  const moreVolumes = row.volumesPresent.length - volumes.length;
  out.push(
    `- the book prints the name in ${row.volumesPresent.length} volume(s): ` +
      volumes.map((volume) => {
        const per = row.perVolume.find((entry) => entry.volume === volume) || { chapters: 0, matches: 0, rules: [] };
        return `volume ${volume} (${per.chapters} chapter(s), ${per.matches} line(s)${per.rules.length ? `, by ${per.rules.join("/")}` : ""})`;
      }).join("; ") +
      (moreVolumes > 0 ? `; ${moreVolumes} more in the JSON` : "")
  );
  out.push(`- total chapter hits across the series: ${row.chaptersTotal}`);
  out.push(
    `- the extraction pass filed ${row.extractionClaims} claim(s) about them; the reference ` +
      `stands behind ${row.recordedClaims}. ` +
      (row.extractionClaims > 0
        ? "Two readings of the same book disagreed, and the published reference took neither."
        : "Nobody wrote anything about them in either pass.")
  );
  if (row.identityKeys.length > 1) {
    out.push(`- counted over every roster entry that is this person: ${row.identityKeys.join(", ")}`);
  }
  out.push(`- why this one is investigated: ${row.decision.because}`);
  out.push("");
  return out;
}

/**
 * The reconciliation log, written.
 *
 * @param {Object} header - `{settled, buckets, counts, limit}` — the record asked, the three buckets, and the bound in force.
 * @returns {string} The file content, ending in a newline.
 */
function renderReconciliationLog(header) {
  const { settled, buckets, counts } = header;
  const investigated = buckets.onPageUnrecorded.filter((row) => !row.decision.fungible);
  const recorded = buckets.onPageUnrecorded.filter((row) => row.decision.fungible);

  const out = [
    "# Closing Cast Reconciliation",
    "",
    `_Written by the character-voice step's own last act, after the last volume. No model was asked ` +
      `anything: every line below is a query over the settled reference record. It files no row, edits no ` +
      `row, seals nothing, and rewrites no published artifact._`,
    "",
    `_Asked of the settled record: ${settled.folder}/${REFERENCE_STORE_FILE_NAME} (volume ${settled.volume}). ` +
      `Roster: ${counts.roster} entr(ies)${counts.mergedEntries ? `, plus ${counts.mergedEntries} merged under another entry` : ""}. ` +
      `Presence measured for ${counts.volumesMeasured.length} of ${counts.volumes.length} registered volume(s)` +
      (counts.volumesUnmeasured.length ? ` — not measured for: ${counts.volumesUnmeasured.join(", ")}` : ".") +
      `_`,
    "",
    `## The three buckets`,
    "",
    "| bucket | what it means | how many | what the pipeline does |",
    "|---|---|---|---|",
    `| named and voiced | the roster holds them and something is recorded about how they speak | ${counts.voiced} | nothing |`,
    `| named and never seen | the roster holds them and the book's own text never puts them on a page | ${counts.neverSeen} | published here as a **named absence** — not a failure |`,
    `| on the page, nothing recorded | the book's text puts them on a page and the record says nothing about them | ${counts.onPageUnrecorded} | investigated when not interchangeable, recorded when it is |`,
    "",
    `## 1. Named and voiced (${counts.voiced})`,
    "",
  ];
  if (counts.voiced === 0) {
    out.push("_Nothing: no volume's reference has recorded how anybody on this roster speaks._", "");
  } else {
    out.push(...nameLines(buckets.voiced, (row) => `- ${row.display} (\`${row.key}\`) — ${row.recordedClaims} recorded claim(s)`));
    out.push("");
  }

  out.push(`## 2. Named, and never seen (${counts.neverSeen})`, "");
  out.push(
    `_This is a **named absence**, not a failure. A character the book never puts on a page is a character ` +
      `the reference has nothing to say about, and no finding is filed for it, no volume is stopped, and no ` +
      `row is written. It is printed so a reader can see the roster holds a name the series never used._`
  );
  out.push("");
  if (counts.neverSeen === 0) {
    out.push("_None: every name on this roster occurs in at least one volume's text._", "");
  } else {
    out.push(...nameLines(buckets.neverSeen, (row) => `- ${row.display} (\`${row.key}\`) — on the roster since volume ${row.firstSeenVolume === null ? "not recorded" : row.firstSeenVolume}; the name occurs in none of the ${counts.volumesMeasured.length} volume(s) whose text was searched`));
    out.push("");
  }

  out.push(`## 3. On the page, and nothing recorded (${counts.onPageUnrecorded})`, "");
  out.push(
    `The per-book guard names these one volume at a time and, since plan 06 slice 9, stops nothing: ` +
      `\`reference-voice-mention-not-covered\` is a NOTE. The decision it used to make is made here, once, ` +
      `for the whole series: is this character interchangeable? The line is ${NOT_FUNGIBLE_MIN_VOLUMES} ` +
      `volumes — a constant in \`character-voice/reconcile/fungibility.js\`, not a setting.`
  );
  out.push("");

  out.push(`### Investigated — not interchangeable (${investigated.length})`, "");
  if (investigated.length === 0) {
    out.push("_Nobody on this roster is printed in 2 or more volumes without the record saying something about them._", "");
  } else {
    out.push(
      `_Investigated means: this pass looked at everything the record already measures about this name and ` +
        `printed it below. It is a query, not a diagnostics turn — 0 model calls, no ticket, no new row._`
    );
    out.push("");
    // The same print bound as every other list, and the same rule: the total is in the section's own
    // heading, the remainder is named by count and lives in full in the JSON. Capping what is spelled out
    // cannot shrink what the file says.
    const dossiers = investigated.slice(0, RECONCILIATION_MAX_NAMES_LISTED);
    for (const row of dossiers) out.push(...dossierLines(row));
    const left = investigated.length - dossiers.length;
    if (left > 0) {
      out.push(`_… ${left} more investigated, each with its own dossier in \`cast-reconciliation.json\` and not spelled out here._`);
      out.push("");
    }
  }

  out.push(`### Recorded and carried on (${recorded.length})`, "");
  out.push(
    `_Interchangeable: the book prints the name in ${NOT_FUNGIBLE_MIN_VOLUMES === 2 ? "one volume only" : `fewer than ${NOT_FUNGIBLE_MIN_VOLUMES} volumes`}. ` +
      `The gap is recorded here and the run continues. Every one of these names is also named per book, in ` +
      `that volume's \`character-voice-validation.md\`, by the guard this pass takes the decision away from._`
  );
  out.push("");
  if (recorded.length === 0) {
    out.push("_None: every uncovered name on this roster is printed in 2 or more volumes._", "");
  } else {
    out.push(...nameLines(recorded, (row) => {
      const held = row.decision.rosterVolumesHeld;
      return `- ${row.display} (\`${row.key}\`) — printed in ${row.decision.volumesSeen} volume(s) (${row.decision.volumesSeenList.join(", ")}), ${row.chaptersTotal} chapter hit(s)${held >= NOT_FUNGIBLE_MIN_VOLUMES ? `, though the roster has held the entry for ${held} volume(s)` : ""}`;
    }));
    out.push("");
  }

  out.push(`## The two recurrence measures, and which one decided`, "");
  out.push(
    `Plan 06 §2.10 quotes **${header.splits.rosterAge.recurring} recurring / ${header.splits.rosterAge.single} single-mention** ` +
      `out of ${counts.roster} roster entries. That measurement counted **how many volume records hold the ` +
      `roster entry** — on a cumulative roster that never drops an entry, that is the entry's age, not how ` +
      `often the book prints it. The rule this pass applied counts **the volumes whose text the store ` +
      `searched and found the name in**:`
  );
  out.push("");
  out.push("| measure | 2 or more | exactly 1 | what it actually counts |");
  out.push("|---|---|---|---|");
  out.push(
    `| held by N volume records (plan §2.10's measure) | ${header.splits.rosterAge.recurring} | ` +
      `${header.splits.rosterAge.single} | how long the roster has carried the entry |`
  );
  out.push(
    `| printed in N volumes' text (**the rule this pass used**) | ${header.splits.presence.recurring} | ` +
      `${header.splits.presence.single} | how often the book puts the name on a page |`
  );
  out.push("");
  out.push(
    `_The two disagree for ${header.splits.disagreement} name(s): the roster has carried them for 2 or more ` +
      `volumes while the book only ever printed them in one. This pass called those interchangeable, which is ` +
      `the owner's decision 1 — "a character mentioned in passing is not worth a paid investigation" — read ` +
      `against the measurement rather than the label._`
  );
  out.push("");

  out.push(`## What this pass could not test`, "");
  out.push(SPEAKER_TEST_NOT_RUN);
  out.push("");
  out.push(`## The miss this rule cannot catch`, "");
  out.push(BLIND_SPOT);
  out.push("");
  out.push(`## What this pass does not do`, "");
  out.push("");
  out.push("- It files no finding, opens no ticket, seals nothing, and writes no row into any reference record.");
  out.push("- It edits, re-labels, moves and deletes nothing in the record it reads. It opens that record read-only.");
  out.push("- It writes nothing into `character-voice.md` or any other published artifact, and it is not a declared artifact itself.");
  out.push("- It makes no model call, and it has no environment knob.");
  out.push("");

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * The machine twin, written.
 *
 * Written whole rather than appended: it is the file a later run diffs against, and a file that has to be
 * repaired before it can be read is a file that gets deleted.
 *
 * @param {Object} opts
 * @param {string} opts.file - Absolute path to `cast-reconciliation.json`.
 * @param {Object} opts.settled - The record this pass read.
 * @param {Object} opts.buckets - The three buckets, every row classified.
 * @param {Object} opts.counts - The counts, as the markdown prints them.
 * @param {Object} opts.splits - The two recurrence splits.
 * @returns {{written: boolean, file: string, error: string|null}}
 */
function writeReconciliationRecord({ file, settled, buckets, counts, splits }) {
  const body = {
    schema: RECONCILIATION_RECORD_SCHEMA,
    writtenAt: new Date().toISOString(),
    settledRecord: { folder: settled.folder, volume: settled.volume, file: settled.file },
    modelCalls: 0,
    limit: { maxNamesListed: RECONCILIATION_MAX_NAMES_LISTED, maxVolumesNamed: RECONCILIATION_MAX_VOLUMES_NAMED, notFungibleMinVolumes: NOT_FUNGIBLE_MIN_VOLUMES },
    counts,
    splits,
    volumes: { registered: counts.volumes, presenceMeasured: counts.volumesMeasured, presenceUnmeasured: counts.volumesUnmeasured },
    speakerTestRun: false,
    speakerTestNotRunBecause: SPEAKER_TEST_NOT_RUN,
    blindSpot: BLIND_SPOT,
    buckets: {
      voiced: buckets.voiced.map((row) => reconciliationEntry(row, "voiced")),
      neverSeen: buckets.neverSeen.map((row) => reconciliationEntry(row, "never-seen")),
      onPageUnrecorded: buckets.onPageUnrecorded.map((row) => reconciliationEntry(row, "on-page-unrecorded", row.decision)),
    },
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
    return { written: true, file, error: null };
  } catch (err) {
    return { written: false, file, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * The lines a run prints about what it found, in the same order the file prints them.
 *
 * Printed even when the pass wrote nothing it had to say: a closing act that stays silent about a roster of
 * 196 names is a closing act nobody can tell the difference between "nothing wrong" and "nobody looked".
 *
 * @param {Object} header - The same header {@link renderReconciliationLog} takes.
 * @returns {string[]}
 */
function describeReconciliation(header) {
  const { counts, splits } = header;
  const investigated = header.buckets.onPageUnrecorded.filter((row) => !row.decision.fungible).length;
  const recorded = counts.onPageUnrecorded - investigated;
  return [
    `cast reconciliation: ${counts.roster} roster entr(ies) over ${counts.volumesMeasured.length} measured volume(s) — ` +
      `${counts.voiced} named and voiced, ${counts.neverSeen} named and never seen, ${counts.onPageUnrecorded} on the page with nothing recorded.`,
    `cast reconciliation: of those ${counts.onPageUnrecorded}, ${investigated} are printed in ${NOT_FUNGIBLE_MIN_VOLUMES}+ volumes and are investigated here, ` +
      `${recorded} are interchangeable and are recorded while the run continues. 0 model calls.`,
    `cast reconciliation: ${SPEAKER_TEST_NOT_RUN}`,
    `cast reconciliation: ${BLIND_SPOT}`,
  ];
}

module.exports = {
  RECONCILIATION_JSON_FILE,
  RECONCILIATION_MD_FILE,
  RECONCILIATION_RECORD_SCHEMA,
  RECONCILIATION_MAX_NAMES_LISTED,
  RECONCILIATION_MAX_VOLUMES_NAMED,
  reconciliationRecordPaths,
  reconciliationEntry,
  renderReconciliationLog,
  writeReconciliationRecord,
  describeReconciliation,
};
