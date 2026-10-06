/**
 * utils/delivery-verify.js — did the intervention help the book?
 *
 * This is the acceptance test for an intervention (plan §5, Phase 4). The delivery manager may
 * wipe a volume's accepted output and re-run a step; the question it is NOT allowed to ask is
 * "did the error go away?". That question is answerable by removing the thing that reported the
 * error, which is the exact failure this whole layer exists to prevent (gotcha 70: volume 15's
 * gate was correctly refusing a glossary that had GROWN, and the cheapest ticket answer was the
 * setting under which 457 terms once vanished). So the question here is the other one:
 *
 *   **Is the deliverable better, the same, or worse than it was before you touched it?**
 *
 * What that means concretely, and why each half is in the list:
 *
 *   1. **The book.** `translation-report.json` is the pipeline's own sign-off on what it
 *      published — per chapter, whether it is PUBLISHED (verified), UNVERIFIED, MISSING, or
 *      empty in the source, with the verification score and the two deterministic drift counts.
 *      It is read through `utils/translation-report.js`, the module that writes it, so the
 *      triage and this comparison cannot describe one report two different ways.
 *   2. **The reference layer.** A glossary intervention cannot move the publish report at all —
 *      the translation stage has not run yet — so the deliverable of THAT step is its own
 *      artifact: how many terms the glossary carries, how many characters the voice reference
 *      holds sections for, which style categories survive, how many chapters the wiki hands off
 *      to the translator. These are the same invariants the pipeline's own carry-forward gates
 *      protect (gotcha 64/65/68), measured here from the outside.
 *   3. **The step's own output.** How many volumes hold what that step always leaves.
 *
 * Two rules decide the verdict, and they are the whole point of the module:
 *
 *   - **A regression vetoes an improvement.** `Add the old spelling back as a second row`
 *     (the option `utils/tickets.js` deliberately does NOT ban) removes the finding and shrinks
 *     the glossary's carried-forward terminology. The finding disappearing is not evidence; the
 *     glossary getting smaller is. So one damage signal outranks any number of improvements,
 *     and the answer is `worse`.
 *   - **A gate's verdict is not a deliverable signal.** PASS/FAIL reports, validation reports
 *     and quarantine evidence are excluded: switching a check off moves them for free. Only
 *     facts about the CONTENT the pipeline produced are measured. This is the difference
 *     between "the complaint stopped" and "the book got better", and it is the reason a
 *     weakened guard cannot be accepted as a fix.
 *
 * What it never does: it does not judge whether an artifact is GOOD (that is the scored gates'
 * job — `PASSING_SCORE`, the rubrics, the acceptance window; gotcha 67), and it does not decide
 * what to do about a regression. It answers one question, in one place, so that "did it help?"
 * has one answer in this codebase: act mode's ledger entry and a ticket's closure both come
 * from `compareDeliverable`.
 *
 * Honesty rules, inherited from the rest of the pipeline:
 *   - **A file that could not be read is not a file with nothing in it.** An unreadable artifact
 *     makes its signal NOT COMPARABLE and says so, exactly like `fingerprintFiles` records an
 *     unreadable file as `missing` so a read error cannot masquerade as "nothing changed".
 *     Treating a read failure as zero terms would report a permissions problem as a loss of the
 *     glossary — the direction of error that gets good work deleted.
 *   - **A signal whose denominator changed is not a signal.** The median verification score is
 *     only compared when both sides graded the same number of chapters; a book that gained a
 *     chapter is a different book, and averaging across it is not a measurement.
 *
 * @module utils/delivery-verify
 */

const fs = require("fs").promises;
const path = require("path");

const { STEP_ARTIFACT_SPECS } = require("./artifacts");
const { parseGlossaryTerms } = require("./translate");
const { readTranslationReport, summarizeReportRows } = require("./translation-report");
const { DISPUTES_FILE } = require("./disputes");
const { PIPELINE_STEPS } = require("../gulpfile");

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One measurement of the deliverable.
 *
 * @typedef {Object} DeliverableSnapshot
 * @property {number} schema
 * @property {string} measuredAt
 * @property {string} seriesDir
 * @property {Object|null} book - The publish report's roll-up (null when there is no report yet).
 * @property {Object} reference - Per cumulative step: what its artifacts actually hold.
 * @property {Object} steps - Per pipeline step: how many volumes have its output.
 * @property {string[]} notes - Measurement honesty: what could not be read, and what was skipped.
 */

/**
 * One signal's movement between two snapshots.
 *
 * @typedef {Object} SignalMovement
 * @property {string} name
 * @property {string} label - What the signal is, in the words a human reads.
 * @property {("better"|"worse"|"none")} direction
 * @property {boolean} veto - Whether a `worse` movement here decides the outcome.
 * @property {boolean} comparable - False when the two sides cannot be compared (and `why` says why).
 * @property {number|null} from
 * @property {number|null} to
 * @property {string} why - What the signal means, and why it is or is not comparable.
 */

// ─── What is measured ─────────────────────────────────────────────────────────

/**
 * The cumulative artifacts, and what counts as their content.
 *
 * `protect` is the half a drop in which counts as damage, and it is deliberately the SAME half
 * each stage's own carry-forward gate protects — a measurement that guarded a different quantity
 * than the gate does would report a different series of failures than the one the pipeline can
 * actually see:
 *   - glossary: the term rows (`GLOSSARY_CARRY_FORWARD_GUARD`, gotcha 64);
 *   - character-voice: the `### Character` sections (`VOICE_CARRY_FORWARD_GUARD`, gotcha 65);
 *   - style-guide: the `## ` category set (`STYLE_CARRY_FORWARD_GUARD`, gotcha 65 — and its rule
 *     COUNT is deliberately NOT protected: "a guide that says the same thing in fewer words is
 *     not damaged", so the count is reported and never vetoes);
 *   - jump-in-wiki: the chapter handoff. `chapters.json` is what the translation stage names its
 *     outputs by, so a chapter that vanishes from it is a chapter the book never gets.
 *
 * @type {Object<string, {primary: string, extra: string, protect: string, unit: string}>}
 */
const REFERENCE_ARTIFACTS = {
  glossary: { primary: "glossary.md", extra: null, protect: "terms", unit: "glossary terms carried" },
  "character-voice": {
    primary: "character-voice.md",
    extra: null,
    protect: "sections",
    unit: "character sections",
  },
  "style-guide": {
    primary: "style-guide.md",
    extra: null,
    protect: "categories",
    unit: "style categories",
  },
  "jump-in-wiki": {
    primary: "shared-wiki.md",
    extra: "chapters.json",
    protect: "chapters",
    unit: "chapters handed to the translator",
  },
};

/**
 * The book signals share one precondition, and therefore one honest reason when it fails.
 *
 * Without this, a series whose translation stage has not run yet produces one "not compared" line
 * per book signal on every action — eight lines of noise that say the same thing, which is how a
 * report stops being read.
 *
 * @param {DeliverableSnapshot} b
 * @param {DeliverableSnapshot} a
 * @returns {true|string}
 */
function bookPresentOnBothSides(b, a) {
  return (
    (b.book && a.book ? true : false) ||
    "there is no publish report on either side — the translation stage has not produced one"
  );
}

/**
 * The signals, as data (the same shape `utils/artifacts.js` declares expectations in).
 *
 * `veto: true` means a `worse` movement decides the outcome no matter how much improved.
 * `veto: false` means the movement is reported and cannot decide anything — the style guide's
 * rule count is the example, because the pipeline's own gate reports a drop there rather than
 * failing on it (gotcha 65).
 *
 * @type {Array<{
 *   name: string,
 *   label: string,
 *   betterWhen: ("up"|"down"),
 *   veto: boolean,
 *   get: function(DeliverableSnapshot): (number|null),
 *   comparable?: function(DeliverableSnapshot, DeliverableSnapshot): (boolean|string),
 *   why: string,
 * }>}
 */
const DELIVERABLE_SIGNALS = [
  // ── The book ────────────────────────────────────────────────────────────────
  {
    name: "publishReport",
    label: "the publish report exists",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? 1 : 0),
    why: "the report IS the sign-off on the deliverable; an intervention that leaves no report left no answer",
  },
  {
    name: "published",
    label: "chapters PUBLISHED (verified)",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? s.book.published : null),
    comparable: bookPresentOnBothSides,
    why: "the book is what the run is for: a chapter that stops being verified is a chapter the reader is warned about",
  },
  {
    name: "unverified",
    label: "chapters UNVERIFIED",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.unverified : null),
    comparable: bookPresentOnBothSides,
    why: "published with a visible warning is still a hole in the book",
  },
  {
    name: "missing",
    label: "chapters MISSING",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.missing : null),
    comparable: bookPresentOnBothSides,
    why: "a chapter the pipeline never produced (as opposed to a hole in the source, which is not the pipeline's failure)",
  },
  {
    name: "verifyScoreMedian",
    label: "median verification score",
    betterWhen: "up",
    veto: true,
    get: (s) => (s.book ? s.book.scoreMedian : null),
    comparable: (b, a) => {
      const present = bookPresentOnBothSides(b, a);
      if (present !== true) return present;
      if (b.book.scoreCount === 0 || a.book.scoreCount === 0) return "no verification scores on both sides";
      return (
        b.book.total === a.book.total ||
        "the chapter list changed size, so the two medians describe different books"
      );
    },
    why: "the same chapters graded worse is a real regression; a different SET of chapters is not a measurement",
  },
  {
    name: "crossChapterHigh",
    label: "HIGH cross-chapter findings",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.crossChapterHigh : null),
    comparable: bookPresentOnBothSides,
    why: "the drift a per-chapter check cannot see: a name rendered two ways, a fact chapter 3 denies in chapter 9",
  },
  {
    name: "variantConflicts",
    label: "rendering-variant conflicts",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.variantConflicts : null),
    comparable: bookPresentOnBothSides,
    why: "the published text using a second rendering of a term the glossary already fixed",
  },
  {
    name: "disputes",
    label: "open glossary disputes",
    betterWhen: "down",
    veto: true,
    get: (s) => (s.book ? s.book.disputes : null),
    comparable: bookPresentOnBothSides,
    why: "the terminology the translation stage found the reference layer got wrong",
  },

  // ── The reference layer ─────────────────────────────────────────────────────
  {
    name: "glossaryTerms",
    label: "glossary terms carried",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference.glossary.termsTotal,
    why: "the glossary is cumulative: 457 terms once vanished between two volumes with no error at all (gotcha 64)",
  },
  {
    name: "glossaryHeadTerms",
    label: "glossary terms in the newest snapshot",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference.glossary.headTerms,
    why: "the newest snapshot is the one every later volume reads, so a loss here cascades",
  },
  {
    name: "voiceSections",
    label: "character sections in the voice reference",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["character-voice"].headCharacterSections,
    why: "the same unit the voice carry-forward gate protects — a reworded heading is not a lost character, a dropped section is (gotcha 65)",
  },
  {
    name: "styleCategories",
    label: "style-guide categories",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["style-guide"].headSections,
    why: "a guide missing \"Address & Honorifics\" has lost everything inside it",
  },
  {
    name: "wikiChapters",
    label: "chapters handed to the translator",
    betterWhen: "up",
    veto: true,
    get: (s) => s.reference["jump-in-wiki"].chaptersHandedOff,
    why: "chapters.json is what the translation stage names its outputs by — a chapter missing from it is a chapter the book never gets",
  },

  // ── Every volume's own copy ─────────────────────────────────────────────────
  {
    name: "referenceVolumes",
    label: "volumes holding a reference artifact",
    betterWhen: "up",
    veto: true,
    get: (s) => Object.values(s.reference).reduce((n, r) => n + r.volumesWith, 0),
    why: "a volume that had its glossary / voice reference / style guide / wiki and no longer has one lost work",
  },
  {
    name: "stepsBuilt",
    label: "volumes holding each step's declared output",
    betterWhen: "up",
    veto: true,
    get: (s) => {
      if (!s.steps) return null;
      const counted = Object.values(s.steps).filter((p) => typeof p.built === "number");
      return counted.length ? counted.reduce((n, p) => n + p.built, 0) : null;
    },
    why: "the coarse half: the files a step always leaves",
  },

  // ── Reported, never decisive ────────────────────────────────────────────────
  {
    name: "styleRules",
    label: "style-guide rules",
    betterWhen: "up",
    veto: false,
    get: (s) => s.reference["style-guide"].headRules,
    why: "reported, not judged: a guide that says the same thing in fewer words is not damaged (gotcha 65), so this cannot decide anything",
  },
  {
    name: "glossarySections",
    label: "glossary sections",
    betterWhen: "up",
    veto: false,
    get: (s) => s.reference.glossary.headSections,
    why: "the glossary's invariant is its terminology, not how its rows are grouped",
  },
  {
    name: "bookChapters",
    label: "chapters in the publish report",
    betterWhen: "up",
    veto: false,
    get: (s) => (s.book ? s.book.total : null),
    comparable: bookPresentOnBothSides,
    why: "a chapter list that grew is not yet a better book — the new chapters land in MISSING until they are translated",
  },
];

// ─── Reading the disk ─────────────────────────────────────────────────────────

/**
 * The largest artifact this measurement will read.
 *
 * The live cumulative glossary reaches ~475 KB, so the cap is not a size opinion — it is the
 * boundary past which "read the whole thing and count it" stops being a cheap deterministic
 * measurement and becomes something that has to be designed differently. Past it the signal is
 * reported as not comparable rather than guessed.
 */
const READ_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Read one file for measurement.
 *
 * The three outcomes are distinct on purpose, because they mean different things to the
 * comparison: absent (the artifact is not there — that IS a fact about the deliverable),
 * unreadable (a fact about this measurement, not about the deliverable), and too big (the same).
 * Collapsing them into "empty" would report a read error as a loss of content, which is the
 * direction of error that gets accepted work deleted.
 *
 * @param {string} filePath
 * @returns {Promise<{state: ("read"|"absent"|"unreadable"), text: string, note: string|null}>}
 */
async function readForMeasurement(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return { state: "unreadable", text: "", note: `${filePath} is not a file` };
    if (stat.size > READ_CAP_BYTES) {
      return {
        state: "unreadable",
        text: "",
        note: `${filePath} is ${stat.size} bytes, over the ${READ_CAP_BYTES}-byte measurement cap`,
      };
    }
    return { state: "read", text: await fs.readFile(filePath, "utf8"), note: null };
  } catch (err) {
    if (err && err.code === "ENOENT") return { state: "absent", text: "", note: null };
    return { state: "unreadable", text: "", note: `${filePath} could not be read (${err.message})` };
  }
}

/**
 * Read one JSON file for measurement, without inventing content when it does not parse.
 * @param {string} filePath
 * @returns {Promise<{state: ("read"|"absent"|"unreadable"), value: Object|null, note: string|null}>}
 */
async function readJsonForMeasurement(filePath) {
  const file = await readForMeasurement(filePath);
  if (file.state !== "read") return { state: file.state, value: null, note: file.note };
  try {
    return { state: "read", value: JSON.parse(file.text), note: null };
  } catch (err) {
    return { state: "unreadable", value: null, note: `${filePath} does not parse (${err.message})` };
  }
}

/**
 * Count Markdown headings at one level.
 *
 * A plain count, deliberately: this is a measurement of the deliverable, not a carry-forward
 * gate. A heading that was REWORDED leaves the count where it was, which is the honest reading
 * for "did the deliverable move" — the pipeline's own gates are what decide whether a renamed
 * entry is a lost entry (gotcha 68), and they are not re-implemented here.
 *
 * @param {string} markdown
 * @param {("##"|"###")} level
 * @returns {number}
 */
function countHeadings(markdown, level) {
  if (!markdown) return 0;
  // A heading is the level marker FOLLOWED BY A SPACE. `"### Character".startsWith("##")` is true,
  // which is why this is a pattern and not a prefix test: the prefix version counts every level-3
  // heading as a level-2 one, and then counts none of them when asked for level 3.
  const pattern = level === "##" ? /^##\s/ : /^###\s/;
  let n = 0;
  for (const line of markdown.split("\n")) {
    if (pattern.test(line.trim())) n += 1;
  }
  return n;
}

/**
 * Count the bullet rules in a style guide (reported only — see `DELIVERABLE_SIGNALS`).
 * @param {string} markdown
 * @returns {number}
 */
function countBulletRules(markdown) {
  if (!markdown) return 0;
  let n = 0;
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) n += 1;
  }
  return n;
}

// ─── The book ─────────────────────────────────────────────────────────────────

/**
 * Measure the deliverable the pipeline itself signs off on.
 *
 * @param {string} seriesDir
 * @param {string[]} notes - Measurement notes are appended here.
 * @returns {Promise<Object|null>} The roll-up, or null when there is no publish report yet.
 */
async function measureBook(seriesDir, notes) {
  const report = await readTranslationReport(seriesDir);
  if (!report) return null;
  const summary = summarizeReportRows(report.chapters);

  // The disputes queue is part of what the run produced (the report itself carries it), and it is
  // the one thing the translation stage discovered that the reference layer has to fix. It is read
  // here rather than through `loadGlossaryDisputes`, because that reader answers "corrupt file"
  // with an empty list — and an empty list would be counted as three disputes having been settled.
  const queue = await readJsonForMeasurement(path.join(seriesDir, DISPUTES_FILE));
  let disputes = 0;
  if (queue.state === "read") {
    const list =
      queue.value && Array.isArray(queue.value.disputes)
        ? queue.value.disputes
        : Array.isArray(queue.value)
          ? queue.value
          : [];
    disputes = list.length;
  } else if (queue.state === "unreadable") {
    disputes = null;
    notes.push(`the glossary disputes queue could not be read — the signal is not compared (${queue.note})`);
  }

  return { present: true, file: report.file, generatedAt: report.generatedAt, disputes, ...summary };
}

// ─── The reference layer ──────────────────────────────────────────────────────

/**
 * Measure one cumulative step's artifacts across the series.
 *
 * The HEAD snapshot (the newest volume's copy) is what every later volume reads, so its content
 * is the content that cascades; the total across volumes is what catches a loss in the middle of
 * the series that the head cannot see.
 *
 * @param {string} step
 * @param {string} seriesDir
 * @param {Array<{folder: string, installment: string}>} volumes
 * @param {string[]} notes
 * @returns {Promise<Object>}
 */
async function measureReference(step, seriesDir, volumes, notes) {
  const spec = REFERENCE_ARTIFACTS[step];
  const unreadable = [];
  let volumesWith = 0;
  let headVolume = null;
  let head = null;
  let termsTotal = 0;
  let chaptersHandedOff = 0;

  for (const v of volumes) {
    const volumeDir = path.join(seriesDir, v.folder);

    // The handoff is read whether or not the primary artifact is there: a volume that lost its
    // wiki still has a chapter list, and the two facts are different facts.
    if (spec.extra) {
      const handoff = await readJsonForMeasurement(path.join(volumeDir, spec.extra));
      if (handoff.state === "read") {
        const list = handoff.value && Array.isArray(handoff.value.chapters) ? handoff.value.chapters : [];
        chaptersHandedOff += list.length;
      } else if (handoff.state === "unreadable") {
        unreadable.push(handoff.note);
      }
    }

    const primary = await readForMeasurement(path.join(volumeDir, spec.primary));
    if (primary.state === "unreadable") {
      unreadable.push(primary.note);
      // Present but unreadable still counts as holding the artifact: the file is there, and
      // "the glossary disappeared" is not a true statement about this folder.
      volumesWith += 1;
      continue;
    }
    if (primary.state === "absent") continue;

    volumesWith += 1;
    headVolume = v.installment; // volumes arrive in reading order
    const text = primary.text;
    // `sections` is the `## ` set — the glossary's groupings, the style guide's protected
    // categories, the wiki's state sections. `characterSections` is the `### ` set, which is the
    // unit the voice reference's carry-forward gate protects.
    head = {
      chars: text.length,
      sections: countHeadings(text, "##"),
      characterSections: countHeadings(text, "###"),
      rules: countBulletRules(text),
      terms: step === "glossary" ? parseGlossaryTerms(text).length : null,
    };

    if (step === "glossary") termsTotal += head.terms;
  }

  if (unreadable.length) {
    notes.push(`${step}: ${unreadable.length} file(s) could not be measured — ${unreadable.join("; ")}`);
  }

  // The honesty rule, applied to the whole step: if any one volume's artifact could not be read,
  // every content number for this step is incomplete, and an incomplete total compared against a
  // complete one reports a loss that did not happen. Presence is still a fact; content is not.
  const blind = unreadable.length > 0;

  return {
    volumesWith,
    headVolume: blind ? null : headVolume,
    headTerms: blind || !head ? null : head.terms,
    termsTotal: blind || step !== "glossary" ? null : termsTotal,
    headSections: blind || !head ? null : head.sections,
    headCharacterSections: blind || !head ? null : head.characterSections,
    headRules: blind || !head ? null : head.rules,
    headChars: blind || !head ? null : head.chars,
    chaptersHandedOff: blind || !spec.extra ? null : chaptersHandedOff,
    unreadableCount: unreadable.length,
    protectedUnit: spec.unit,
  };
}

/**
 * How many volumes hold each step's declared output.
 *
 * Read from the resume inventory (`missingForStep`), which is `utils/artifacts.js`'s declaration
 * compared against the folder with `{installment}` resolved — the same comparison the post-mortem
 * and the resume triage make, so the measurement cannot disagree with them about what a step
 * leaves behind (gotcha 71).
 *
 * The two series-level steps (`discover`, `consistency-audit`) declare no per-volume output, so
 * counting them per volume would report "17 of 17 built" for a series that has no audit report at
 * all. They are measured against their own series-root deliverable instead: one deliverable, one
 * or zero.
 *
 * @param {Array<{exists: boolean, missingForStep: Array<{step: string}>}>} volumes
 * @param {string} seriesDir
 * @returns {Promise<Object<string, {built: number, missing: number}>|null>}
 */
async function measureStepProgress(volumes, seriesDir) {
  if (!Array.isArray(volumes) || volumes.length === 0) return null;
  const out = {};

  for (const { name } of PIPELINE_STEPS) {
    const spec = STEP_ARTIFACT_SPECS[name];
    if (spec && spec.perVolume === false) {
      const required = (spec.series || []).filter((e) => e.level === "required");
      if (!required.length) {
        out[name] = { built: null, missing: null };
        continue;
      }
      let present = 0;
      for (const e of required) {
        const read = await readForMeasurement(path.join(seriesDir, e.name.replace("{installment}", "")));
        // Present-but-unreadable counts as present: the file is there, and "the audit report is
        // gone" would be a false statement about the folder.
        if (read.state !== "absent") present += 1;
      }
      out[name] = present === required.length ? { built: 1, missing: 0 } : { built: 0, missing: 1 };
      continue;
    }

    let built = 0;
    let missing = 0;
    for (const v of volumes) {
      const gap = (v.missingForStep || []).some((m) => m.step === name);
      if (v.exists && !gap) built += 1;
      else missing += 1;
    }
    out[name] = { built, missing };
  }

  return out;
}

/**
 * Measure the deliverable.
 *
 * @param {{seriesDir?: string, volumes?: Array<import("./resume").VolumeInventory>}} [opts]
 *   `volumes` is the resume inventory; without it the working state is read (no model call, no
 *   writes — `readWorkingState` is a pure read of the disk).
 * @returns {Promise<DeliverableSnapshot>}
 */
async function measureDeliverable({ seriesDir, volumes } = {}) {
  const dir = path.resolve(seriesDir || process.env.SERIES_LOCATION || process.cwd());
  const notes = [];

  let inventory = volumes;
  if (!Array.isArray(inventory)) {
    // Late require on purpose: a caller that already has the volume list never needs the triage,
    // and keeping `utils/resume.js` out of this module's top-level requires means the triage can
    // read the measurement later without the two files requiring each other.
    const { readWorkingState } = require("./resume");
    const state = await readWorkingState({ seriesDir: dir });
    inventory = state.volumes || [];
    if (!state.manifest) notes.push("there is no plan of record, so the volume list is empty and nothing is measured");
  }

  const reference = {};
  for (const step of Object.keys(REFERENCE_ARTIFACTS)) {
    reference[step] = await measureReference(step, dir, inventory, notes);
  }

  return {
    schema: 1,
    measuredAt: new Date().toISOString(),
    seriesDir: dir,
    book: await measureBook(dir, notes),
    reference,
    steps: await measureStepProgress(inventory, dir),
    notes,
  };
}

// ─── The comparison ───────────────────────────────────────────────────────────

/**
 * Compare two measurements of the deliverable.
 *
 * The verdict rule, stated plainly because it is the thing a reader must be able to check:
 *   **any veto-eligible regression ⇒ `worse`, whatever else improved;**
 *   otherwise any improvement ⇒ `improved`;
 *   otherwise `unchanged`.
 *
 * A regression beating an improvement is not caution, it is the acceptance criterion: the fix
 * this module exists to reject is the one that removes a finding while shrinking the deliverable
 * (gotcha 70), and a rule that averaged the two would call it a net win.
 *
 * @param {DeliverableSnapshot} before
 * @param {DeliverableSnapshot} after
 * @returns {{
 *   outcome: ("improved"|"unchanged"|"worse"),
 *   movements: SignalMovement[],
 *   regressions: SignalMovement[],
 *   improvements: SignalMovement[],
 *   noted: SignalMovement[],
 *   notComparable: SignalMovement[],
 * }}
 */
function compareDeliverable(before, after) {
  const movements = [];

  for (const signal of DELIVERABLE_SIGNALS) {
    const from = signal.get(before);
    const to = signal.get(after);

    let reason = null;
    if (signal.comparable) {
      const ok = signal.comparable(before, after);
      if (ok !== true) reason = typeof ok === "string" ? ok : "the two sides are not comparable";
    }
    // The backstop: a signal that produced no number on one side cannot be compared, whatever its
    // own precondition said. Comparing `null` against a number is how a read failure becomes a
    // phantom regression — `null > 1` is false, so a missing measurement reads as damage.
    if (reason === null && (from === null || to === null || from === undefined || to === undefined)) {
      reason = "nothing measurable on both sides";
    }

    if (reason) {
      movements.push({
        name: signal.name,
        label: signal.label,
        direction: "none",
        veto: signal.veto,
        comparable: false,
        from: typeof from === "number" ? from : null,
        to: typeof to === "number" ? to : null,
        why: `${signal.why} — not compared: ${reason}`,
      });
      continue;
    }

    let direction = "none";
    if (to !== from) direction = (to > from) === (signal.betterWhen === "up") ? "better" : "worse";

    movements.push({
      name: signal.name,
      label: signal.label,
      direction,
      veto: signal.veto,
      comparable: true,
      from,
      to,
      why: signal.why,
    });
  }

  const regressions = movements.filter((m) => m.direction === "worse" && m.veto);
  const improvements = movements.filter((m) => m.direction === "better" && m.veto);
  const noted = movements.filter((m) => m.direction !== "none" && !m.veto);
  const notComparable = movements.filter((m) => !m.comparable);

  const outcome = regressions.length ? "worse" : improvements.length ? "improved" : "unchanged";
  return { outcome, movements, regressions, improvements, noted, notComparable };
}

/**
 * The comparison as the lines a human reads.
 *
 * Every signal that moved is printed, including the ones that cannot decide anything, and every
 * signal that could not be compared is printed with its reason. A verdict with no account next
 * to it is a verdict nobody can argue with.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @returns {string[]}
 */
function describeComparison(comparison) {
  const lines = [];
  const skipped = new Map();
  for (const m of comparison.movements) {
    if (!m.comparable) {
      const reason = m.why.split(" — not compared: ")[1] || m.why;
      skipped.set(reason, (skipped.get(reason) || []).concat(m.label));
      continue;
    }
    if (m.direction === "none") continue;
    const mark =
      m.direction === "worse"
        ? m.veto
          ? "WORSE"
          : "worse (reported only)"
        : "better";
    lines.push(`  – ${m.label}: ${m.from} → ${m.to}  [${mark}]`);
  }
  for (const [reason, labels] of skipped) {
    lines.push(`  – ${labels.length > 1 ? `${labels.length} signals` : labels[0]}: not compared — ${reason}`);
  }
  if (comparison.regressions.length) {
    lines.push(
      `  damage outranks whatever improved: ${comparison.regressions.map((r) => r.label).join(", ")} — ` +
        "an intervention that shrinks the deliverable is not a fix, whatever it removed."
    );
  }
  return lines;
}

/**
 * The compact account of a snapshot, for storing next to a ledger entry or a ticket.
 *
 * The full snapshot is a measurement of a whole series; this is the handful of numbers a human
 * (or the diagnostics team, later) needs in order to see what moved.
 *
 * @param {DeliverableSnapshot} snapshot
 * @returns {Object}
 */
function summarizeSnapshot(snapshot) {
  const ref = snapshot.reference || {};
  return {
    published: snapshot.book ? snapshot.book.published : null,
    unverified: snapshot.book ? snapshot.book.unverified : null,
    missing: snapshot.book ? snapshot.book.missing : null,
    glossaryTerms: ref.glossary ? ref.glossary.termsTotal : null,
    glossaryHeadVolume: ref.glossary ? ref.glossary.headVolume : null,
    voiceSections: ref["character-voice"] ? ref["character-voice"].headCharacterSections : null,
    styleCategories: ref["style-guide"] ? ref["style-guide"].headSections : null,
    wikiChapters: ref["jump-in-wiki"] ? ref["jump-in-wiki"].chaptersHandedOff : null,
  };
}

/**
 * The account: what moved, in one line.
 *
 * The verdict is useless without it. "worse" is a decision; "glossary terms carried 445→412" is
 * the thing a human can agree or disagree with, and the thing the diagnostics team needs in order
 * to start anywhere near the right place.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @returns {string}
 */
function accountOf(comparison) {
  const moved = comparison.movements.filter((m) => m.comparable && m.direction !== "none");
  if (!moved.length) return "nothing in the deliverable moved";
  return moved
    .map((m) => `${m.label} ${m.from} → ${m.to}${m.direction === "worse" && m.veto ? " [damage]" : ""}`)
    .join("; ");
}

/**
 * The closure payload `utils/tickets.js` accepts, produced from the same comparison act mode
 * records.
 *
 * This is the seam the plan asked for: "did it help?" has one answer in this codebase. A ticket
 * cannot close as `finding-gone` (that is already refused by `closeTicket`), and it must not be
 * closed on a different measurement than the one the ledger recorded — so the outcome and the
 * note both come from here.
 *
 * @param {ReturnType<typeof compareDeliverable>} comparison
 * @param {string} [note] - Whoever is closing the ticket adds what they did; the measurement
 *   cannot be edited by the person it is judging.
 * @returns {{outcome: ("improved"|"unchanged"|"worse"), note: string}}
 */
function closureFromComparison(comparison, note = "") {
  const parts = [`measured on the deliverable: ${comparison.outcome}`, accountOf(comparison)];
  if (comparison.regressions.length) {
    parts.push(`refused as a fix because it damaged: ${comparison.regressions.map((r) => r.label).join(", ")}`);
  }
  if (comparison.notComparable.length) {
    parts.push(`${comparison.notComparable.length} signal(s) could not be compared`);
  }
  if (note) parts.push(note);
  return { outcome: comparison.outcome, note: parts.join(". ") };
}

module.exports = {
  DELIVERABLE_SIGNALS,
  REFERENCE_ARTIFACTS,
  READ_CAP_BYTES,
  measureDeliverable,
  measureBook,
  compareDeliverable,
  describeComparison,
  accountOf,
  summarizeSnapshot,
  closureFromComparison,
};
