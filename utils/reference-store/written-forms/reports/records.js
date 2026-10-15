/**
 * utils/reference-store/written-forms/reports/records.js — where a source-quality report is allowed to
 * write, what it looks like when it has written, and the two refusals that keep it out of the places it
 * must not write.
 *
 * Plan 07 slice 2b. Both reports are written twice, in the shape `glossary/settlement/records.js` and
 * `character-voice/reconcile/records.js` already use: a machine twin (`…​.json`, every collision, every
 * count, so a later run can diff the answer) and the one a person reads (`…​.md`, the same split in the
 * order a reader needs it).
 *
 * ## Where they live, and where they are refused
 *
 * In a folder the **caller** passes. No stage calls either door, so nothing in a run resolves this path
 * today; when a slice wires one, the folder is the run's own records (`<series>/.run/postmortem/`),
 * beside the extraction reports and the settlement's decisions. The door refuses an `out` that is the
 * volume folder it was opened on, anything inside it, or the series root above it, because:
 *
 *   - a volume folder is where the acceptance gate grades **three named files**, and an ungraded fourth
 *     file sitting there is a file that looks graded;
 *   - the series root is where the published `glossary.md` / `character-voice.md` / `style-guide.md` /
 *     `shared-wiki.md` live, and these reports are not those;
 *   - neither report is declared in `utils/artifacts/`, so the post-mortem does not check them and a
 *     report that wrote nothing cannot reach the resume triage or the halt gate — the same hole gotcha
 *     138 records, and closing it is an owner decision, not a slice detail.
 *
 * ## Why the files carry no timestamp
 *
 * `cast-reconciliation.json` writes a `writtenAt`. These two do not, on purpose: the whole point of the
 * machine twin is that **the same record gives the same answer**, and a timestamp makes two identical
 * answers differ in bytes. `test/test-source-quality-reports.js` asserts the second pass is byte-identical,
 * which is the check a timestamp would silently defeat.
 *
 * @module utils/reference-store/written-forms/reports/records
 */

const fs = require("fs");
const path = require("path");

const { refusal } = require("../../refusals");
require("../../../../types"); // JSDoc type definitions

/**
 * The record's own shape version. Bumped only when an existing entry would be read wrongly.
 * @type {number}
 */
const SOURCE_QUALITY_RECORD_SCHEMA = 1;

/**
 * How many entries one section spells out before it starts counting the rest instead.
 *
 * A **print** bound, not a decision bound: every section's own sentence states the total, the remainder is
 * named by count, and the full list is in the JSON. Capping what is spelled out cannot shrink what the
 * file says — which is the rule `character-voice/reconcile/records.js` states and this file follows.
 *
 * @type {number}
 */
const SOURCE_QUALITY_MAX_LISTED = 40;

/** The variant-spelling report's two files. */
const VARIANT_REPORT_FILES = Object.freeze({
  markdown: "source-variant-spellings.md",
  json: "source-variant-spellings.json",
});

/** The inconsistent-guidance report's two files. */
const GUIDANCE_REPORT_FILES = Object.freeze({
  markdown: "source-inconsistent-guidance.md",
  json: "source-inconsistent-guidance.json",
});

/**
 * The sentence both reports print about themselves, so a reader cannot mistake a report for a finding.
 *
 * @type {string}
 */
const SOURCE_QUALITY_NOT_A_FINDING =
  "Nothing in this file is a finding, a ticket, a level or a stop. It files no row, edits no row, seals " +
  "nothing, rewrites no published artifact, and is not a declared artifact: the post-mortem does not look " +
  "for it, so it cannot reach the resume triage or the volume-boundary halt gate.";

/**
 * Ask the two doors' shared questions before either reads anything: is this a record, how far may it look,
 * and is the folder it was told to write into a folder it is allowed to write into.
 *
 * Every answer is a refusal, not a throw: a report is a read, and a read that was asked the wrong question
 * should say which one (doc 03 §3.2, the same rule `refusals.js` states).
 *
 * @param {Object} opts
 * @param {Object} opts.store - An opened reference-store handle.
 * @param {string} opts.verb - The door's verb, stamped on every refusal.
 * @param {number} [opts.upToVolume] - Defaults to the record's own volume.
 * @param {string} [opts.out] - Folder to write the two files into, or nothing.
 * @returns {{ok: boolean, refusal: ReferenceRefusal|null, ceiling: number, out: string|null, volumeDir: string|null}}
 */
function sourceQualityReportScope({ store, verb, upToVolume, out } = {}) {
  const volume = store && Number.isInteger(Number(store.volume)) ? Number(store.volume) : null;
  if (!store || !store.db || volume === null) {
    return {
      ok: false,
      refusal: refusal({
        verb,
        rule: "source-quality-report-needs-an-open-record",
        because:
          "this report is a query over one volume's reference record, and the handle it was handed has no " +
          "`db` or no volume number.",
        useInstead: ["openReferenceStore"],
        fix: "open the record first: openReferenceStore({ volume: 17, folder, seriesDir, stage: \"merge\" }).",
      }),
      ceiling: 0,
      out: null,
      volumeDir: null,
    };
  }

  const ceiling = Number(upToVolume === undefined ? volume : upToVolume);
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    return {
      ok: false,
      refusal: refusal({
        verb,
        rule: "source-quality-report-volume-undecided",
        because: `"${upToVolume}" is not a volume number, and a written form is dated by the volume whose book printed it.`,
        fix: `${verb}(store, { upToVolume: 3 })`,
      }),
      ceiling: 0,
      out: null,
      volumeDir: store.volumeDir || null,
    };
  }
  // The no-forward rule, asked before anything is read. A record is what this volume and the volumes
  // before it measured; asking it about a later book would report a fact this volume never published.
  if (ceiling > volume) {
    return {
      ok: false,
      refusal: refusal({
        verb,
        rule: "source-quality-cannot-look-forward",
        because:
          `this record is volume ${volume} and has not read volume ${ceiling}'s book. A source-quality report ` +
          "answers what this record already holds (plan 07 §4.4): looking forward would describe a book this " +
          "volume's snapshot never saw.",
        fix: `open the record for volume ${ceiling}, or ask with upToVolume <= ${volume}.`,
        detail: { recordVolume: volume, askedVolume: ceiling },
      }),
      ceiling: 0,
      out: null,
      volumeDir: store.volumeDir || null,
    };
  }

  if (out === undefined || out === null || out === "") return { ok: true, refusal: null, ceiling, out: null, volumeDir: store.volumeDir || null };

  const target = path.resolve(String(out));
  const volumeDir = store.volumeDir ? path.resolve(store.volumeDir) : null;
  const seriesRoot = volumeDir ? path.dirname(volumeDir) : null;
  const insideVolume = volumeDir !== null && (target === volumeDir || target.startsWith(volumeDir + path.sep));
  const isSeriesRoot = seriesRoot !== null && target === seriesRoot;
  if (insideVolume || isSeriesRoot) {
    return {
      ok: false,
      refusal: refusal({
        verb,
        rule: "source-quality-report-not-a-volume-artifact",
        because:
          `${target} is ${insideVolume ? "the volume folder this record writes its graded artifacts into" : "the series root the published glossary, character-voice reference, style guide and wiki live in"}. ` +
          "A source-quality report is the run's own record: it is not graded, not declared, and not a published file, " +
          "and putting it where the acceptance gate looks makes an ungraded file look graded.",
        useInstead: ["the run's records folder"],
        fix: "pass `out` as <series>/.run/postmortem (where the extraction reports and the settlement's decisions already live), or omit it and read the returned object.",
        detail: { out: target, volumeDir, seriesRoot },
      }),
      ceiling,
      out: null,
      volumeDir,
    };
  }
  return { ok: true, refusal: null, ceiling, out: target, volumeDir };
}

/**
 * Print a list without letting a long one bury the count it belongs to.
 *
 * @param {Array<Object>} rows
 * @param {(row: Object) => string} line
 * @param {string} jsonFile - The file the remainder is named in.
 * @returns {string[]} The lines, ending with the named remainder when the cap bit.
 */
function nameLines(rows, line, jsonFile) {
  const shown = (Array.isArray(rows) ? rows : []).slice(0, SOURCE_QUALITY_MAX_LISTED);
  const out = shown.map(line);
  const left = (Array.isArray(rows) ? rows.length : 0) - shown.length;
  if (left > 0) out.push(`_… ${left} more named in \`${jsonFile}\` and not spelled out here._`);
  return out;
}

/**
 * One written form, printed the way the report prints it: the form, its count, the volumes it appeared in,
 * and the chapters those volumes recorded it in.
 *
 * The count is **volume-wide** and the sentence says so. `written_forms.occurrences` is how many times a
 * volume guided this form this way, not how many times this chapter did, and a report that printed
 * `113 in ch0` would be read as a chapter count that the row does not hold.
 *
 * @param {{form: string, count: number, chaptersByVolume?: Array<{volume: string, chapters: string[]}>}} form
 * @returns {string}
 */
function formLine(form) {
  const places = (form.chaptersByVolume || [])
    .map((entry) => `volume ${entry.volume}${entry.chapters && entry.chapters.length ? ` (${entry.chapters.join(", ")})` : ""}`)
    .join("; ");
  return `${form.form} — ${form.count} guided occurrence(s)${places ? `, recorded in ${places}` : ""}`;
}

/**
 * The variant-spelling report, for a person.
 *
 * @param {Object} result - What `variant.js`'s `variantSpellingReport` returned (an ok result).
 * @returns {string} The file content, ending in a newline.
 */
function renderVariantSpellingLog(result) {
  const jsonFile = VARIANT_REPORT_FILES.json;
  const totals = result.totals;
  const out = [
    "# Source Variant Spellings",
    "",
    `_Written by a query over one volume's reference record. No model was asked anything, and nothing was ` +
      `read out of a book: every line below is a row the record already holds in \`written_forms\`. ` +
      `${SOURCE_QUALITY_NOT_A_FINDING}`,
    "",
    `_Asked of: volume ${result.recordVolume}'s record, rows up to volume ${result.upToVolume}. ` +
      `Rows in that record: ${result.rows.total} (${result.rows.occurrences} guided occurrences) across ` +
      `${result.rows.volumes} volume(s). Candidate groups the rows describe: ${result.groups.total}; ` +
      `${result.groups.identityBearing} the record's roster selects, ${result.groups.unselected} it cannot see._`,
    "",
    `## 1. One word, two spellings (${totals.spellingVariants})`,
    "",
    `_Printed the way a dictionary prints *color* / *colour*: both spellings, both counts, no verdict. This is ` +
      `plan 07 §2.10's spelling-variant class — at least ${result.minRatio} of the shorter written form survives ` +
      `inside the longer one, as a longest common subsequence. It is a note about how the book spells a word, ` +
      `not a claim that one spelling is wrong._`,
    "",
  ];

  if (totals.spellingVariants === 0) {
    out.push("_None: no group the roster cannot see reads as one word spelled two ways._", "");
  } else {
    out.push("| guided reading | the two spellings | how much of the shorter survives | rows | occurrences | volumes |");
    out.push("|---|---|---|---|---|---|");
    for (const group of result.spellingVariants.slice(0, SOURCE_QUALITY_MAX_LISTED)) {
      out.push(
        `| \`${group.reading}\` | \`${group.closestPair.a}\` / \`${group.closestPair.b}\` | ` +
          `${group.closestPair.shared} of ${group.closestPair.shorter} (${group.ratio.toFixed(2)}) | ` +
          `${group.rowCount} | ${group.occurrences} | ${group.volumes.join(", ")} |`
      );
    }
    const left = totals.spellingVariants - Math.min(totals.spellingVariants, SOURCE_QUALITY_MAX_LISTED);
    if (left > 0) out.push(`_… ${left} more in \`${jsonFile}\`._`);
    out.push("");
    out.push("### Where the book prints each one", "");
    out.push(
      `_The count is what **that volume** guided this form this way — the row's own number, not a count of ` +
        `the chapters listed beside it._`
    );
    out.push("");
    for (const group of result.spellingVariants.slice(0, SOURCE_QUALITY_MAX_LISTED)) {
      out.push(`#### \`${group.reading}\``);
      for (const form of group.forms) out.push(`- ${formLine(form)}`);
      out.push("");
    }
    if (left > 0) out.push(`_… ${left} more groups with their own entry in \`${jsonFile}\`._`, "");
  }

  out.push(`## 2. Different words that happen to sound alike (${totals.soundAlikes})`, "");
  out.push(
    `_**Named as a class, and not reported as errors.** Plan 07 §2.10 measured these and the account owner's ` +
      `answer was to judge them case by case: 美味 / 上手 / 旨 under うま, 披露 / 疲労 under ひろう. The author ` +
      `glossed ordinary homophones out of habit, and a rule that called them errors would cry wolf ` +
      `${totals.soundAlikes} times over ${result.rows.volumes} legitimate book(s)._`
  );
  out.push("");
  if (totals.soundAlikes === 0) {
    out.push("_None._", "");
  } else {
    out.push(...nameLines(result.soundAlikes, (group) => {
      const pair = group.closestPair && group.closestPair.a ? `closest pair ${group.closestPair.a} / ${group.closestPair.b} survives ${group.closestPair.shared} of ${group.closestPair.shorter}` : "no pair survives";
      return `- \`${group.reading}\` — ${group.forms.map((form) => `${form.form} ×${form.count}`).join(" / ")}; ${group.rowCount} row(s), ${group.occurrences} occurrence(s), ${pair}`;
    }, jsonFile));
    out.push("");
  }

  out.push(`## 3. The half this report does not print (${result.identityBearingVariantsNotReported.groups})`, "");
  out.push(
    `_The record's own roster selects **${result.groups.identityBearing}** of the ${result.groups.total} groups ` +
      `its rows describe — a written form, or the guided reading itself, is already a published entry (plan 07 §2.9). ` +
      `${result.identityBearingVariantsNotReported.groups} of those would pass the same spelling test this report ` +
      `applies to the ${result.groups.unselected} it cannot see` +
      (result.identityBearingVariantsNotReported.readings.length ? `: ${result.identityBearingVariantsNotReported.readings.join(", ")}` : "") +
      `. They are **not** printed as variants here: the record already treats those spellings as one name, and ` +
      `that claim belongs to the identity table (plan 07 slice 2), not to a spelling note._`
  );
  out.push("");

  out.push("## What this report does not do", "");
  out.push("");
  out.push("- It files nothing, edits nothing, seals nothing, and marks nothing `disputed`.");
  out.push(`- It writes nothing into \`glossary.md\` or any other published artifact. Whether "also written 偽者" should reach a term's row is plan 07 §6.4, and it is not decided here.`);
  out.push("- It makes no model call, reads no book, and has no environment knob.");
  out.push(`- It is not a declared artifact, so the post-mortem does not check that it exists.`);
  out.push("");
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * The inconsistent-guidance report, for a person.
 *
 * @param {Object} result - What `guidance.js`'s `inconsistentGuidanceReport` returned (an ok result).
 * @returns {string} The file content, ending in a newline.
 */
function renderGuidanceLog(result) {
  const jsonFile = GUIDANCE_REPORT_FILES.json;
  const anomalies = result.anomalyTotals.total;
  const out = [
    "# Source Inconsistent Guidance",
    "",
    `_Written by a query over one volume's reference record. No model was asked anything, and nothing was ` +
      `read out of a book. ${SOURCE_QUALITY_NOT_A_FINDING}`,
    "",
    `_Asked of: volume ${result.recordVolume}'s record, rows up to volume ${result.upToVolume}. ` +
      `Rows in that record: ${result.rows.total} (${result.rows.occurrences} guided occurrences) across ` +
      `${result.rows.volumes} volume(s). Candidate groups the rows describe: ${result.groups.total}, of which ` +
      `${result.groups.identityBearing} the record's roster selects._`,
    "",
    `## 1. What this report calls a defect (${anomalies})`,
    "",
    `_${result.ruleNote}_`,
    "",
  ];

  if (anomalies === 0) {
    out.push("_None: no written form is guided two ways in one chapter with two readings made of the same characters in a different order, and no reading is printed over two spellings of that shape._", "");
  } else {
    for (const collision of result.anomalies.transposedReadings) {
      out.push(`### ${collision.form} — volume ${collision.volume}, chapter ${collision.chapter}`);
      out.push(`- guided ${collision.readings.map((reading) => `\`${reading.reading}\` (${reading.occurrences})`).join(" and ")}`);
      out.push(`- the two guided readings are **the same characters in a different order**: ${(collision.transposedPair || []).map((value) => `\`${value}\``).join(" / ") || "the pair is in the JSON"}`);
      out.push(`- the count beside each reading is what **the whole volume** guided, not what this chapter did.`);
      out.push("");
    }
    for (const collision of result.anomalies.transposedForms) {
      out.push(`### ${collision.reading} — volume ${collision.volume}, chapter ${collision.chapter}`);
      out.push(`- printed over ${collision.forms.map((form) => `\`${form.form}\` (${form.occurrences})`).join(" and ")}`);
      out.push(`- the two written forms are **the same characters in a different order**.`);
      out.push("");
    }
  }

  out.push(`## 2. The widths, as counts and not as findings`, "");
  out.push("| shape | collisions | (volume, key) pairs | distinct keys |");
  out.push("|---|---|---|---|");
  out.push(`| one written form guided 2+ ways **somewhere in the record** | — | ${result.widths.formsWithMoreThanOneReading.pairs} | ${result.widths.formsWithMoreThanOneReading.keys} forms |`);
  out.push(`| one written form guided 2+ ways **in one chapter** | ${result.widths.formCollisions.collisions} | ${result.widths.formCollisions.pairs} | ${result.widths.formCollisions.keys} forms |`);
  out.push(`| one guided reading printed over 2+ written forms **in one chapter** | ${result.widths.readingCollisions.collisions} | ${result.widths.readingCollisions.pairs} | ${result.widths.readingCollisions.keys} readings |`);
  out.push("");
  out.push(
    `_Neither width is a defect. A 17-book series reads 嫌 as いや, きら and ぎら and prints 貴女 and 貴方 in the ` +
      `same chapter; that is what the author's own markup says. They are printed here because plan 07 §6.5 asks ` +
      `how many of these there are **before** anyone decides whether one is worth stopping a run for._`
  );
  out.push("");

  out.push(`### 2a. One written form, more than one reading, in one chapter (${result.widths.formCollisions.collisions})`, "");
  out.push(...nameLines(result.formCollisions, (collision) => `- volume ${collision.volume} ${collision.chapter} — \`${collision.form}\` guided ${collision.readings.map((reading) => `${reading.reading} (${reading.occurrences})`).join(" / ")}`, jsonFile));
  out.push("");

  out.push(`### 2b. One guided reading, two written forms, in one chapter (${result.widths.readingCollisions.collisions})`, "");
  out.push("Each collision lands in exactly one bucket, and the buckets add up to the total.");
  out.push("");
  out.push("| bucket | collisions | pairs | what it is |");
  out.push("|---|---|---|---|");
  out.push(`| the reading is not a candidate group in this record | ${result.buckets.notACandidateGroup.collisions} | ${result.buckets.notACandidateGroup.pairs} | one of the two group guards bit: the reading is 1 character, or every form is 1 character |`);
  out.push(`| the group is one the record's roster already selects | ${result.buckets.identityBearing.collisions} | ${result.buckets.identityBearing.pairs} | plan 07 §2.9's rule already treats these spellings as one name — **slice 2's door, not a defect** |`);
  out.push(`| the two forms are one word spelled two ways | ${result.buckets.spellingVariant.collisions} | ${result.buckets.spellingVariant.pairs} | **the other report's class**: \`source-variant-spellings.md\` prints the ones its rule reaches |`);
  out.push(`| ordinary sound-alikes | ${result.buckets.soundAlike.collisions} | ${result.buckets.soundAlike.pairs} | plan 07 §2.10 measured these as **not errors** |`);
  out.push("");
  out.push(`Of the ${result.widths.readingCollisions.collisions}, these are spelled out (each carries the bucket it was sorted into; the rest are in \`${jsonFile}\`):`);
  out.push("");
  out.push(...nameLines(result.readingCollisions, (collision) => `- [${collision.bucket}] volume ${collision.volume} ${collision.chapter} — \`${collision.reading}\` printed over ${collision.forms.map((form) => `${form.form} (${form.occurrences})`).join(" / ")}`, jsonFile));
  out.push("");

  out.push("## 3. The rule this report refuses to use", "");
  out.push(
    `_**"${result.rejectedRule.name}"** — the rule plan 07 §2.11 measured against the raw harvest at ` +
      `**${result.rejectedRule.measuredByPlan.rawHarvestCandidatePairs} candidate pairs** and rejected. What it ` +
      `flags is the noise: ${result.rejectedRule.measuredByPlan.falsePositivesNamedByPlan07.join("; ")}. ` +
      `What it misses is the defect above: ${result.rejectedRule.because} ` +
      `It is implemented in \`${result.rejectedRule.implementedIn}\` so it can be re-measured against the same ` +
      `rows (\`test/measure-source-quality.js\` runs it beside this report), and **no door in this layer calls ` +
      `it** — \`${result.rejectedRule.calledByNoDoor ? "calledByNoDoor: true" : "calledByNoDoor: false"}\` in the JSON._`
  );
  out.push("");

  out.push("## What this report does not do", "");
  out.push("");
  out.push("- It files nothing, edits nothing, seals nothing, and marks nothing `disputed`. It adds no finding kind and no level.");
  out.push("- It never calls a form a typo, a name, or a person. It says which strings the author guided which way, and stops.");
  out.push("- It writes nothing into `glossary.md` or any other published artifact, and it is not a declared artifact.");
  out.push("- It makes no model call, reads no book, and has no environment knob.");
  out.push("");
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Write one report's two files.
 *
 * @param {Object} opts
 * @param {string} opts.out - Folder to write into.
 * @param {{markdown: string, json: string}} opts.names - The two file names.
 * @param {Object} opts.result - The report's machine shape.
 * @param {string} opts.markdown - The rendered log.
 * @returns {{written: boolean, markdown: string, json: string, error: string|null}}
 */
function writeSourceQualityReport({ out, names, result, markdown }) {
  const jsonFile = path.join(out, names.json);
  const markdownFile = path.join(out, names.markdown);
  if (!out) return { written: false, markdown: markdownFile, json: jsonFile, error: "no out folder was given: the report was returned and not written" };
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2) + "\n", "utf8");
    fs.writeFileSync(markdownFile, markdown, "utf8");
    return { written: true, markdown: markdownFile, json: jsonFile, error: null };
  } catch (err) {
    return { written: false, markdown: markdownFile, json: jsonFile, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * The lines a caller prints about a variant report, so a pass that found nothing is distinguishable from a
 * pass that never looked.
 *
 * @param {Object} result
 * @returns {string[]}
 */
function describeVariantSpellingReport(result) {
  if (!result.ok) return [`variant spellings: refused — ${result.refusal.rule}: ${result.refusal.because}`];
  return [
    `variant spellings: ${result.totals.spellingVariants} group(s) of one word spelled two ways ` +
      `(${result.totals.variantRows} row(s), ${result.totals.variantOccurrences} occurrence(s)); ` +
      `${result.totals.soundAlikes} group(s) named as sound-alikes and not reported as errors. 0 model calls.`,
    `variant spellings: ${result.identityBearingVariantsNotReported.groups} group(s) the roster already selects are left to the identity door and not printed here.`,
  ];
}

/**
 * The lines a caller prints about a guidance report.
 *
 * @param {Object} result
 * @returns {string[]}
 */
function describeGuidanceReport(result) {
  if (!result.ok) return [`inconsistent guidance: refused — ${result.refusal.rule}: ${result.refusal.because}`];
  return [
    `inconsistent guidance: ${result.anomalyTotals.total} defect(s) named ` +
      `(${result.anomalyTotals.transposedReadings} reading(s) guided two ways with the moras reordered, ` +
      `${result.anomalyTotals.transposedForms} reading(s) printed over two spellings of that shape). 0 model calls.`,
    `inconsistent guidance: widths — ${result.widths.formCollisions.collisions} same-chapter form collisions over ${result.widths.formCollisions.pairs} form(s), ` +
      `${result.widths.readingCollisions.collisions} same-chapter reading collisions over ${result.widths.readingCollisions.pairs} reading(s); all reported as counts.`,
  ];
}

module.exports = {
  SOURCE_QUALITY_RECORD_SCHEMA,
  SOURCE_QUALITY_MAX_LISTED,
  VARIANT_REPORT_FILES,
  GUIDANCE_REPORT_FILES,
  SOURCE_QUALITY_NOT_A_FINDING,
  sourceQualityReportScope,
  nameLines,
  formLine,
  renderVariantSpellingLog,
  renderGuidanceLog,
  writeSourceQualityReport,
  describeVariantSpellingReport,
  describeGuidanceReport,
};
