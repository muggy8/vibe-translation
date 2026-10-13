/**
 * utils/prereqs/freeze.js — the other half of the prerequisite gate: a step may not **rewrite**
 * what a finished translation already consumed.
 *
 * `utils/prereqs.js` answers "may this step START?". This file answers the question that gate
 * cannot: "may this step REWRITE something a published translation was built from?". The account
 * owner's rule is one sentence — *if we are on the translation step, the pre-production artifacts
 * are frozen and are not expected to be changed, and that holds when a run is resumed* — and until
 * 2026-10-13 nothing enforced the second half of it. Measured against the code:
 *
 *   - `utils/series-run/skip.js`'s first line is `if (force || regeneratedAny) return false;`. It
 *     never asks whether anything downstream already consumed what it is about to rebuild;
 *   - `configs/shared/acceptance.js`'s `isSourceStale` compares exactly one checksum, the **source
 *     book's**. Nothing links a finished translation to the glossary it was translated from;
 *   - the cascade (`regeneratedAny`) runs inside one step only.
 *
 * So today: rewrite volume 5's glossary after volumes 1–8 are translated, resume, and the run
 * prints "already accepted, skipping" for eight translations built from a glossary that no longer
 * exists. Nothing says so.
 *
 * ## "Frozen" is read off the disk
 *
 * A volume is frozen when the `translate` step's own declared `required` per-volume artifacts are
 * in its folder. The names come from `specForStep("translate")` in `utils/artifacts.js` — never a
 * second list written here. That is the mistake gotcha 141 is about: two lists of one artifact
 * become two opinions about whether a volume is finished. A resumed run answers the same question a
 * fresh run does, because the answer is a folder listing and not a memory of the current process.
 *
 * ## The freeze is on REWRITING, not on looking
 *
 * The prerequisite gate makes `discover` and `extract` run before **every** step. If the freeze
 * blocked them outright, a resumed run sitting in the translation stage could not run anything at
 * all. So the question is never "is this step allowed to run?" but **"would this act actually
 * rewrite it?"** — and that question is answered by the same conditions `utils/series-run/skip.js`
 * already uses to cancel its own skip (`force`, the cascade, a changed source fingerprint, a failing
 * acceptance state, a missing output). `utils/series-run/skip.js` now computes that decision in
 * `skipDecisionFor` and this file reads the same decision; there is no second copy of the rule.
 *
 * A frozen volume whose skip stands is **not** a refusal. `extract` on a warm cache verifies each
 * volume's bundle and rewrites nothing; `discover` reuses the plan of record; `consistency-audit`
 * skips while its provenance sidecar still fingerprints the four artifacts. All three must keep
 * working on a frozen series — the offline pipeline loop's second pass, which must make zero model
 * calls, is the test that proves this half got it right (gotcha 130: a gate that fires on
 * legitimate output is worse than no gate).
 *
 * ## The one cancellation that is not a rewrite
 *
 * `missing-output` — the artifact this door would write is not there. Filling a hole in a
 * half-built series is not overwriting something a translation consumed, and refusing it would make
 * an inconsistent series unrepairable. It is the only skip-cancelling condition that does not count
 * as a rewrite, and the reason is written beside it in the door table rather than left as an
 * absence.
 *
 * ## There is no switch. There is a recorded act.
 *
 * AGENTS.md §4 rule 3. No flag, no environment variable, no ledger entry and no run policy reaches
 * this gate: `--force`, `--allow-fail`, `ON_TASK_ERROR=continue` and `ON_VOLUME_ERROR=skip` are not
 * inputs to the question, and a refusal is a **structural** error so none of them can walk past it.
 * The only way through is `release-translation.js` — the shape `reopen-volume.js` established
 * (gotcha 113): a typed reason (refused under 20 characters, the same floor as `reopen`), a row in
 * the run's own records naming the volumes whose translation it invalidates and the artifact it is
 * about to rewrite, and nothing done to a translation: it does not delete, edit, mark or schedule
 * anything in a translation folder. A release is **standing** — it does not expire — because the
 * translation artifacts stay on disk, so a release that expired would make the volume impossible to
 * rebuild. It is therefore named in the resume triage and the delivery report for as long as it
 * exists.
 *
 * ## Where the table lives, and why it cannot be edited from a process
 *
 * This file is in `utils/prereqs/`, which `utils/patches/rules.js`'s `constraint-tables` pattern
 * already bans (`/^utils\/(?:…|prereqs)(?:\.js|\/)/` matches the folder as well as the file), for
 * the reason that ban already gives for the prerequisite table: a role that can edit the rule that
 * stops it is not being stopped. The door table is `Object.freeze`d on top of that, because a table
 * any importing module can reassign is a dial.
 *
 * @module utils/prereqs/freeze
 */

const fs = require("fs");
const path = require("path");

const { specForStep } = require("../artifacts");
const { postMortemDir } = require("../postmortem");
const { structuralError } = require("../../configs/shared");
const { readVolumesInScope } = require("../prereqs");

/** @typedef {import("../artifacts").ArtifactExpectation} ArtifactExpectation */
/** @typedef {import("../types").TranslationTargetVolume} TranslationTargetVolume */

// ─── The door table ───────────────────────────────────────────────────────────

/**
 * One door this gate covers, and why it is covered.
 *
 * @typedef {Object} FreezeDoorRow
 * @property {string} door - The gulp task name, or the manual command's own name for the four root
 *   doors that are not gulp tasks and therefore never pass through `gulpfile.js`.
 * @property {"volume"|"series"} scope - `volume`: the refusal is per volume. `series`: the door
 *   writes one thing for the whole series, so it is frozen when ANY volume in scope is frozen.
 * @property {string} writes - What this door rewrites, in the words a refusal prints.
 * @property {boolean} missingIsRepair - Whether an ABSENT artifact counts as a hole to fill rather
 *   than a thing to overwrite. True only where the door's own output is a declared per-volume
 *   artifact; `extract` rewrites the extracted text whether or not a file of its own is present.
 * @property {string} because - Why this door is inside the gate at all.
 */

/**
 * Every door the freeze covers.
 *
 * The five pre-production gulp steps, `discover` and `extract` under the "would this act actually
 * rewrite it" rule, and the four manual doors — which are root commands rather than gulp tasks, so
 * no wrapper can reach them and each one calls this gate itself.
 *
 * @type {Record<string, FreezeDoorRow>}
 */
const FREEZE_DOORS = Object.freeze({
  glossary: {
    door: "glossary",
    scope: "volume",
    writes: "this volume's `glossary.md` and its reference record",
    missingIsRepair: true,
    because:
      "the glossary is the one thing the translation stage cannot repair afterwards, and every later " +
      "volume amends this volume's copy",
  },
  "character-voice": {
    door: "character-voice",
    scope: "volume",
    writes: "this volume's `character-voice.md`, its `pov-map.md` and its reference record",
    missingIsRepair: true,
    because:
      "the voice reference decides how a character sounds in every volume after this one, and the " +
      "record is copied forward into each of them",
  },
  "style-guide": {
    door: "style-guide",
    scope: "volume",
    writes: "this volume's `style-guide.md`",
    missingIsRepair: true,
    because: "the cumulative style guide is the base the next volume amends and the translator follows",
  },
  "jump-in-wiki": {
    door: "jump-in-wiki",
    scope: "volume",
    writes: "this volume's `wiki.md`, `shared-wiki.md`, `chapters.json` and `translation-brief.md`",
    missingIsRepair: true,
    because:
      "`chapters.json` is the chapter list the translation stage iterated and `shared-wiki.md` is the " +
      "story state it was told about this volume",
  },
  "consistency-audit": {
    door: "consistency-audit",
    scope: "series",
    writes: "the series' `consistency-report.md` — the sign-off those translations were built on",
    missingIsRepair: true,
    because:
      "re-signing after the fact makes the sign-off describe a state that no longer matches what was " +
      "translated. A plain run skips while its provenance sidecar still fingerprints the four " +
      "artifacts, so this never blocks a legal resumed `translate` — the prerequisite gate asks " +
      "whether the audit is COMPLETE, not whether it may run",
  },
  discover: {
    door: "discover",
    scope: "series",
    writes: "the plan of record (`translation-target.json`, `translation-plan.md`)",
    missingIsRepair: false,
    because:
      "every volume folder, every reading order and every source file name downstream came from this " +
      "plan; re-deciding it re-decides which book each finished translation was made from. A plain " +
      "run reuses the cached plan and is not a rewrite",
  },
  extract: {
    door: "extract",
    scope: "volume",
    writes: "the extracted text this volume's translation was translated from",
    missingIsRepair: false,
    because:
      "`--force` re-extracts every volume and so rewrites the text a published translation is a " +
      "translation OF. A warm-cache run only VERIFIES that text against the archive and writes " +
      "nothing, which is why it is allowed on a frozen series",
  },
  "rebuild-voice": {
    door: "rebuild-voice",
    scope: "volume",
    writes: "this volume's `character-voice.md` / `pov-map.md`, and it seals the record beside them",
    missingIsRepair: false,
    because:
      "`--apply` publishes into the volume folder and seals the record the next volume copies forward. " +
      "A rehearsal without `--apply` writes nothing into the series folder and stays allowed — that " +
      "door exists so a renderer change can be seen before it is published",
  },  "extract-voice": {
    door: "extract-voice",
    scope: "volume",
    writes: "this volume's extraction notebook and its reference record (`series.db`)",
    missingIsRepair: false,
    because:
      "it re-reads the volume chapter by chapter and re-files the record a published reference — and " +
      "therefore a published translation — was rendered from",
  },
  "reopen-volume": {
    door: "reopen-volume",
    scope: "volume",
    writes: "this volume's published reference record (it retires the record whole)",
    missingIsRepair: false,
    because:
      "retiring a record is the first half of rebuilding the reference a translation was built from, " +
      "so it is the act the freeze exists to make deliberate",
  },
  "attribute-voice": {
    door: "attribute-voice",
    scope: "volume",
    writes: "claims this volume's published reference already makes (it marks them `disputed`)",
    missingIsRepair: false,
    because:
      "a published claim a translation was built on is left standing but marked contested, which " +
      "changes what the reference says about who speaks those words",
  },
});

/**
 * The manual doors are not gulp tasks, so the artifact they threaten is a gulp step's artifact.
 * This is the mapping the refusal prints, and the reason a rehearsal of one of them is judged
 * against the same folder as the stage it belongs to.
 *
 * @type {Record<string, string>}
 */
const DOOR_OWNER = Object.freeze({
  "rebuild-voice": "character-voice",
  "extract-voice": "character-voice",
  "reopen-volume": "character-voice",
  "attribute-voice": "character-voice",
});

/**
 * The floor a reason has to clear, in characters. The same floor `reopen-volume.js` enforces
 * (`utils/reference-store/reopen.js`'s `MIN_REOPEN_REASON_CHARS`): "redo" is the act restated, not a
 * reason, and the record this writes is read by whoever opens these volumes next.
 */
const MIN_RELEASE_REASON_CHARS = 20;

/** The file the release acts are recorded in, inside the run's own records folder. */
const RELEASE_RECORD_FILE = "translation-releases.json";

/** The shape of that file. */
const RELEASE_RECORD_SCHEMA = 1;

/**
 * The cancellations that mean "this act writes nothing".
 *
 * The freeze is on REWRITING, not on looking, and that rule is enforced here rather than left to each
 * caller's restraint: a door that reports one of these is not asking to overwrite anything, and the gate
 * says so in its own verdict instead of trusting that nobody would ask. `extract` on a warm cache,
 * `discover` reusing the plan of record, and a volume whose skip stands are the three real cases.
 *
 * Anything NOT listed is treated as a rewrite, including a word this file has never seen — a gate that
 * failed closed on an unrecognised cancellation would be a gate a caller could not widen by inventing a
 * label.
 *
 * @type {Record<string, string>}
 */
const NOT_A_REWRITE = Object.freeze({
  skip: "the skip stands: this run rebuilds nothing",
  "cache-verified": "the extracted text was verified against the archive and rewritten by nobody",
  "plan-cached": "the plan of record was reused from disk",
  "audit-fresh": "the report still fingerprints the four artifacts it audited",
});

/**
 * Is one door inside the gate?
 *
 * @param {string} door - A gulp task name or a manual door name.
 * @returns {FreezeDoorRow|null} The row, or null when this door is not gated.
 */
function freezeDoorRow(door) {
  return FREEZE_DOORS[String(door || "")] || null;
}

/**
 * The doors this gate covers, in table order.
 *
 * @returns {string[]}
 */
function frozenDoors() {
  return Object.keys(FREEZE_DOORS);
}

// ─── What "frozen" means, read off the folder ─────────────────────────────────

/**
 * The `translate` step's own declared `required` per-volume artifact names, with the volume's
 * `{installment}` placeholder resolved.
 *
 * Written as a query over the declaration rather than as a list, on purpose: `translation.md` and
 * `translation-state.json` are what they are because `utils/artifacts/translation.js` says so, and a
 * second list here is a second opinion about whether a volume is translated (gotcha 141).
 *
 * @param {string} installment - The volume's two-digit installment number.
 * @returns {string[]} Declared names, resolved. Empty when `translate` declares no per-volume output.
 */
function requiredTranslationArtifacts(installment) {
  const spec = specForStep("translate");
  if (!spec || !spec.perVolume) return [];
  return spec.volume
    .filter((expect) => expect.level === "required")
    .map((expect) => expect.name.replace(/\{installment\}/g, String(installment || "")));
}

/**
 * One volume folder: has a translation been published on top of this volume's reference artifacts?
 *
 * @param {Object} opts
 * @param {string} opts.volumeDir - The volume folder.
 * @param {string} opts.installment - The volume's installment number.
 * @returns {Promise<{frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>} The verdict
 *   and the translation files that produced it, with their sizes so a refusal can name what is at
 *   stake rather than assert it.
 */
async function readFrozenState({ volumeDir, installment }) {
  const names = requiredTranslationArtifacts(installment);
  if (names.length === 0) return { frozen: false, artifacts: [] };
  /** @type {Array<{name: string, bytes: number}>} */
  const present = [];
  for (const name of names) {
    try {
      const st = await fs.promises.stat(path.join(volumeDir, name));
      if (st.isFile()) present.push({ name, bytes: st.size });
    } catch {
      return { frozen: false, artifacts: [] };
    }
  }
  return { frozen: present.length === names.length, artifacts: present };
}

/**
 * The volumes this invocation is about to touch, each with its freeze verdict.
 *
 * `--volume NN` narrows the question to that volume, exactly as the prerequisite gate narrows its
 * own — a legal `--volume 03` must not be blocked by a frozen volume 01 this run does not touch.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir
 * @param {string|null} [opts.volumeArg] - The `--volume` filter.
 * @param {TranslationTargetVolume[]} [opts.volumes] - Pass the volumes the caller already resolved
 *   (the per-volume gate inside a stage walk has them in hand) instead of reading the plan again.
 * @returns {Promise<{volumes: Array<{installment: string, folder: string, frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>, error: string|null}>}
 */
async function readFreezeScope({ seriesDir, volumeArg = null, volumes = null }) {
  let entries;
  if (volumes) {
    entries = volumes;
  } else {
    const read = readVolumesInScope(seriesDir, volumeArg);
    if (read.error) return { volumes: [], error: read.error };
    entries = read.volumes;
  }
  /** @type {Array<{installment: string, folder: string, frozen: boolean, artifacts: Array<{name: string, bytes: number}>}>} */
  const out = [];
  for (const entry of entries) {
    const installment = String(entry.installmentNumber || entry.folder);
    const state = await readFrozenState({ volumeDir: path.join(seriesDir, entry.folder), installment });
    out.push({ installment, folder: entry.folder, ...state });
  }
  return { volumes: out, error: null };
}

// ─── The release act ──────────────────────────────────────────────────────────

/**
 * One recorded release: the account owner saying, in writing, that these volumes' translations no
 * longer vouch for what the references now say.
 *
 * @typedef {Object} TranslationRelease
 * @property {string} id - Stable, citable id.
 * @property {string} at - ISO timestamp.
 * @property {string[]} volumes - The installment numbers whose translation this invalidates.
 * @property {string[]} doors - The doors this release lets rewrite those volumes.
 * @property {string[]} artifacts - The artifacts it is about to rewrite, named.
 * @property {string[]} invalidated - The translation files that stop vouching, named from the
 *   `translate` declaration rather than typed by the person running the command.
 * @property {string} reason - The owner's reason, in their words.
 * @property {string} by - The command that wrote it.
 */

/**
 * Where the release records live. Resolved at CALL time — `POSTMORTEM_DIR` / `SERIES_LOCATION` are
 * settings, and a machine-state path frozen at require time is gotcha 79 arriving again (gotcha 94).
 *
 * @returns {string} Absolute path.
 */
function releaseRecordPath() {
  return path.join(postMortemDir(), RELEASE_RECORD_FILE);
}

/**
 * Read every recorded release.
 *
 * A file that cannot be read is reported, never silently treated as "no releases": the freeze gate
 * reads this answer, and a gate that fails open is a gate that fails (the `readLedger` rule).
 *
 * @param {string} [file] - Override the record path (a test that points at its own fixture).
 * @returns {{releases: TranslationRelease[], file: string, error: string|null}}
 */
function readTranslationReleases(file = releaseRecordPath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { releases: [], file, error: null };
    return { releases: [], file, error: `the translation release record could not be read (${err.message})` };
  }
  const rows = Array.isArray(parsed && parsed.releases) ? parsed.releases : null;
  if (!rows) return { releases: [], file, error: `the translation release record is not the shape it declares (${file})` };
  return { releases: rows.filter((r) => r && typeof r === "object" && Array.isArray(r.volumes)), file, error: null };
}

/**
 * Does a recorded release cover this (volume, door)?
 *
 * Per door on purpose: releasing `glossary` does not release `character-voice`. Each door is a
 * different artifact and a different act, and the reason has to be typed for each one.
 *
 * @param {TranslationRelease[]} releases
 * @param {string} installment - The volume's installment number.
 * @param {string} door
 * @returns {TranslationRelease|null} The newest release that covers it, or null.
 */
function releaseCovering(releases, installment, door) {
  const wanted = String(installment || "");
  let found = null;
  for (const r of releases || []) {
    const volumes = (r.volumes || []).map((v) => String(v));
    const doors = (r.doors || []).map((d) => String(d));
    if (!volumes.includes(wanted)) continue;
    if (!doors.includes(String(door)) && !doors.includes(DOOR_OWNER[String(door)] || "")) continue;
    if (!found || String(r.at || "") > String(found.at || "")) found = r;
  }
  return found;
}

/**
 * Record a release.
 *
 * The act is deliberately thin, and every part of it is a guard: a reason under
 * `MIN_RELEASE_REASON_CHARS` is refused, the volumes must name volumes this series actually has, the
 * doors must be doors this gate actually covers, and **nothing in a translation folder is touched** —
 * this function writes one record into the run's own records and does not delete, edit, mark or
 * schedule a single file in a volume folder.
 *
 * @param {Object} opts
 * @param {string[]} opts.volumes - Installment numbers whose translation this invalidates.
 * @param {string[]} opts.doors - The doors this release lets rewrite them.
 * @param {string} opts.reason - The owner's reason.
 * @param {string} [opts.file] - Override the record path (a test that points at its own fixture).
 * @returns {{ok: boolean, release: TranslationRelease|null, file: string, refusal: {rule: string, because: string}|null}}
 */
function recordTranslationRelease({ volumes, doors, reason, file = releaseRecordPath() }) {
  const refuse = (rule, because) => ({ ok: false, release: null, file, refusal: { rule, because } });

  const wanted = (volumes || []).map((v) => String(v)).filter(Boolean);
  const asked = (doors || []).map((d) => String(d)).filter(Boolean);
  const text = String(reason === undefined || reason === null ? "" : reason).trim();

  if (wanted.length === 0) return refuse("no-volume", "name the volumes whose translation this invalidates, e.g. --volume=01,02");
  if (asked.length === 0) return refuse("no-door", `name the door you are releasing (--door=${Object.keys(FREEZE_DOORS).join("|")})`);
  if (text.length < MIN_RELEASE_REASON_CHARS) {
    return refuse(
      "reason-too-thin",
      `a release reason has to say why, in at least ${MIN_RELEASE_REASON_CHARS} characters — the same floor ` +
        `reopen-volume.js holds. You typed ${text.length}. The record this writes is what whoever opens ` +
        `these volumes next reads the translations against.`
    );
  }
  const unknown = asked.filter((d) => !freezeDoorRow(d));
  if (unknown.length) {
    return refuse(
      "unknown-door",
      `${unknown.join(", ")} is not a door this gate covers. It covers: ${Object.keys(FREEZE_DOORS).join(", ")}.`
    );
  }

  /** @type {Set<string>} */
  const artifacts = new Set();
  /** @type {Set<string>} */
  const invalidated = new Set();
  for (const installment of wanted) {
    for (const name of requiredTranslationArtifacts(installment)) invalidated.add(name);
    for (const door of asked) {
      const owner = DOOR_OWNER[door] || door;
      const spec = specForStep(owner);
      for (const expect of (spec && spec.volume) || []) {
        if (expect.level !== "required") continue;
        artifacts.add(expect.name.replace(/\{installment\}/g, installment));
      }
    }
  }

  const stamp = new Date().toISOString();
  /** @type {TranslationRelease} */
  const release = {
    id: `REL-${stamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${wanted.join("+")}-${asked.join("+")}`,
    at: stamp,
    volumes: wanted,
    doors: asked,
    artifacts: [...artifacts].sort(),
    invalidated: [...invalidated].sort(),
    reason: text,
    by: "release-translation.js",
  };

  const existing = readTranslationReleases(file);
  if (existing.error) return refuse("record-unreadable", existing.error);
  const next = [...existing.releases, release];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema: RELEASE_RECORD_SCHEMA, releases: next }, null, 2) + "\n", "utf8");
  } catch (err) {
    return refuse("record-unwritable", `the release could not be recorded (${err.message}). A release that is not on disk is not a release.`);
  }
  return { ok: true, release, file, refusal: null };
}

// ─── The verdict ──────────────────────────────────────────────────────────────

/**
 * One frozen volume, phrased as something a person can act on.
 *
 * @typedef {Object} FreezeGap
 * @property {string} installment
 * @property {string} folder
 * @property {string[]} artifacts - The translation files that make this volume frozen.
 * @property {string} cancelledBy - Why the skip would have been cancelled (`force`, `cascade`,
 *   `source-changed`, `failed-grade`, `no-acceptance-state`, `audit-stale`, `plan-stale`).
 * @property {string} line - The rendered bullet.
 */

/**
 * The words a refusal uses for each reason a skip would be cancelled.
 *
 * They are the same reasons `utils/series-run/skip.js` computes, spelled out here so the refusal
 * names the act rather than the word: "frozen" is a refusal nobody can act on.
 *
 * @type {Record<string, string>}
 */
const CANCEL_WORDS = Object.freeze({
  force: "`--force` was given",
  cascade: (/** @type {string} */ from) => `volume ${from} is being rebuilt in this same run, and this volume's copy is built on it`,
  "source-changed": "the source book changed since this volume was accepted (fingerprint mismatch)",
  "failed-grade": "this volume's acceptance window never met the criterion, so its grade would not hold",
  "no-acceptance-state": "this volume has no readable acceptance window, so nothing says it was signed off",
  "audit-stale": "the four audited artifacts no longer match the fingerprints the report carries",
  "plan-stale": "`--force` re-runs the intake and re-decides the plan of record",
  // The four manual doors are not gulp tasks and have no skip check to cancel. Their cancellation is
  // the act itself: the command was typed, and it is about to write. Naming it keeps every refusal
  // the same shape — "X would be rewritten because <the act>" — instead of printing a bare word.
  act: "this command was asked to re-read and re-file this volume's reference record",
  apply: "`--apply` publishes into the volume folder and seals the record beside it",
});

/**
 * The sentence for one frozen volume.
 *
 * @param {Object} opts
 * @param {FreezeDoorRow} opts.row
 * @param {{installment: string, folder: string, artifacts: Array<{name: string, bytes: number}>}} opts.volume
 * @param {string} opts.cancelledBy
 * @param {string} [opts.detail]
 * @returns {FreezeGap}
 */
function freezeGap({ row, volume, cancelledBy, detail }) {
  const cancel = CANCEL_WORDS[cancelledBy] || cancelledBy;
  const why = typeof cancel === "function" ? cancel(detail || "") : cancel;
  const built = volume.artifacts.map((a) => `\`${a.name}\` (${a.bytes} bytes)`).join(" and ");
  return {
    installment: volume.installment,
    folder: volume.folder,
    artifacts: volume.artifacts.map((a) => a.name),
    cancelledBy,
    line:
      `volume ${volume.installment} (${volume.folder}): ${row.writes} would be rewritten because ${why}, ` +
      `and this volume's translation was built on it — ${built} is in that folder.`,
  };
}

/**
 * The artifacts this door is about to overwrite in this volume, resolved from the door's own
 * declaration.
 *
 * A volume door is excused when the file it would write is NOT there — filling a hole is not
 * overwriting. A series door is judged by its series-root copy (`consistency-report.md`), which is
 * the only thing it writes. `extract` and `discover` declare nothing per volume and are not excused:
 * what they rewrite is the extracted text and the plan of record, and neither is a declared
 * per-volume file.
 *
 * **The acceptance records are not part of the answer.** `*-validation.md` and
 * `*-validation-*-rolling-state.json` are this pipeline's own gate records, not a thing a translation
 * read — `utils/prereqs.js` and `utils/postmortem/volume.js` both single them out the same way, and
 * `utils/series-run/skip.js` keys its skip on the rolling-state file. If they counted here, deleting
 * one would open the freeze on a volume whose published artifact is untouched: the manager's own
 * `wipe-and-cascade` deletes exactly that set, so counting them would make the gate a door the run
 * opens by removing its own paperwork.
 *
 * @param {FreezeDoorRow} row
 * @param {string} door
 * @param {string} installment
 * @returns {string[]} Empty when this door has no declared artifact to stand in for the act.
 */
function doorArtifacts(row, door, installment) {
  const owner = DOOR_OWNER[door] || door;
  const spec = specForStep(owner);
  if (!spec) return [];
  const list = row.scope === "series" ? spec.series || [] : spec.volume || [];
  return list
    .filter((expect) => expect.level === "required" && !isAcceptanceRecord(expect))
    .map((expect) => expect.name.replace(/\{installment\}/g, installment));
}

/**
 * Is one declared expectation this pipeline's own gate paperwork rather than an artifact a translation
 * consumed?
 *
 * The same two shapes `utils/prereqs.js` (its acceptance half) and `utils/postmortem/volume.js` (its
 * `accepted-without-acceptance` check) already single out, so the three of them agree on what a
 * validation report and an acceptance window ARE.
 *
 * @param {{name: string, shape?: string}} expect - A declared expectation.
 * @returns {boolean}
 */
function isAcceptanceRecord(expect) {
  const name = String((expect && expect.name) || "");
  return /-validation(?:-\{installment\})?\.md$/.test(name) ||
    (expect.shape === "json" && name.endsWith("-rolling-state.json"));
}

/**
 * Ask whether one door may rewrite what it is about to rewrite.
 *
 * Reads the disk only. It writes nothing, makes no model call, and consults no flag: `--force`,
 * `--allow-fail`, `ON_TASK_ERROR=continue`, `ON_VOLUME_ERROR=skip`, the ledger and the resume menu
 * are not inputs to this question — the CALLER reports `cancelledBy`, which is what its own act
 * would do, not a permission.
 *
 * @param {Object} opts
 * @param {string} opts.door - The gulp task name or the manual door name.
 * @param {string} opts.seriesDir - `SERIES_LOCATION`.
 * @param {string} opts.cancelledBy - Why this act would rewrite rather than skip, from the door's own
 *   skip decision (`skipDecisionFor` in utils/series-run/skip.js, or the door's own freshness rule).
 *   One of `NOT_A_REWRITE` means the act writes nothing and the gate passes it without reading a folder.
 * @param {string} [opts.detail] - Extra fact the wording needs (the cascade's source volume).
 * @param {string|null} [opts.volumeArg] - The `--volume` filter.
 * @param {TranslationTargetVolume[]} [opts.volumes] - The volumes the caller already resolved.
 * @param {TranslationRelease[]} [opts.releases] - Recorded releases the caller has already read. When
 *   omitted this function reads the release record itself.
 * @returns {Promise<{
 *   ok: boolean, door: string, gated: boolean, frozen: FreezeGap[],
 *   headline: string, bullets: string[], message: string, recordError: string|null,
 * }>}
 */
async function evaluateFreeze({ door, seriesDir, cancelledBy, detail, volumeArg = null, volumes = null, releases = null }) {
  const row = freezeDoorRow(door);
  const pass = { ok: true, door, gated: Boolean(row), frozen: [], headline: "", bullets: [], message: "", recordError: null, notARewrite: null };
  if (!row) return pass;
  // "Frozen" is only ever a reason to refuse an act that REWRITES. A door reporting one of the
  // not-a-rewrite cancellations is not asking to overwrite anything, and the gate says so in its own
  // verdict rather than relying on the caller not to ask (the rule, in the table, not in the callers).
  if (NOT_A_REWRITE[String(cancelledBy || "")]) return { ...pass, notARewrite: NOT_A_REWRITE[String(cancelledBy)] };
  if (!seriesDir) {
    return {
      ...pass,
      ok: false,
      frozen: [],
      headline: `${door} refuses to rewrite anything: SERIES_LOCATION is not set, so nothing can be checked.`,
      bullets: [],
      message: `${door} refuses to rewrite anything: SERIES_LOCATION is not set.`,
    };
  }

  const scope = await readFreezeScope({ seriesDir, volumeArg, volumes });
  if (scope.error) {
    return {
      ...pass,
      ok: false,
      headline: `${door} refuses to rewrite anything: ${scope.error}`,
      bullets: [scope.error],
      message: `${door} refuses to rewrite anything: ${scope.error}`,
    };
  }

  let releaseRows = releases;
  let recordError = null;
  if (!Array.isArray(releaseRows)) {
    const read = readTranslationReleases();
    releaseRows = read.releases;
    recordError = read.error;
  }

  // An unrecognised cancellation is treated as a rewrite. A gate that failed OPEN on a word it did not
  // know would be a gate a caller could widen by inventing a label.
  const undeclared = !CANCEL_WORDS[String(cancelledBy || "")] && !NOT_A_REWRITE[String(cancelledBy || "")];

  /** @type {FreezeGap[]} */
  const frozen = [];
  for (const volume of scope.volumes) {
    if (!volume.frozen) continue;
    if (releaseCovering(releaseRows, volume.installment, door)) continue;
    if (row.missingIsRepair) {
      // Filling a hole is not overwriting. The artifact this door would write is not there, so the
      // act completes a half-built volume rather than replacing what a translation consumed. This is
      // the one skip-cancelling condition that is NOT a rewrite, and it is what keeps the gate from
      // refusing a half-translated series for being half-translated (gotcha 130).
      //
      // A SERIES door is judged against the series root, which is the only folder it writes; judging
      // it against a volume folder would find `consistency-report.md` missing in every volume and
      // excuse the audit from the freeze entirely.
      const base = row.scope === "series" ? seriesDir : path.join(seriesDir, volume.folder);
      const names = doorArtifacts(row, door, volume.installment);
      const present = names.filter((name) => fs.existsSync(path.join(base, name)));
      if (names.length > 0 && present.length < names.length) continue;
    }
    frozen.push(freezeGap({ row, volume, cancelledBy, detail }));
  }

  if (frozen.length === 0) return { ...pass, recordError, undeclaredCancellation: undeclared };

  const shown = frozen.slice(0, 8);
  const hidden = frozen.length - shown.length;
  const bullets = shown.map((g) => g.line);
  if (hidden > 0) bullets.push(`… ${hidden} more frozen volume(s).`);
  if (undeclared) {
    bullets.push(
      `(the reason given for rewriting — ${JSON.stringify(cancelledBy)} — is not one this gate knows, so it is ` +
        `treated as a rewrite rather than waved through.)`
    );
  }
  const volumesArg = frozen.map((g) => g.installment).join(",");
  bullets.push(
    `To do this on purpose: \`node release-translation.js --volume=${volumesArg} --door=${door} ` +
      `--reason="…"\` — a reason of at least ${MIN_RELEASE_REASON_CHARS} characters, recorded in the run's ` +
      `own records, naming the translations it invalidates. It touches no translation.`
  );
  const headline =
    `${door} refuses to rewrite ${frozen.length} volume(s): their translation is already published. ` +
    `This gate has no override.`;
  return {
    ok: false,
    door,
    gated: true,
    frozen,
    headline,
    bullets,
    message: `${headline}\n  - ${bullets.join("\n  - ")}`,
    recordError,
    undeclaredCancellation: undeclared,
  };
}

/**
 * The refusal this gate throws: a STRUCTURAL error, so `ON_TASK_ERROR=continue` and
 * `ON_VOLUME_ERROR=skip` cannot walk past it (the shape `utils/postmortem/halt.js` uses).
 *
 * @param {string} message
 * @returns {Error}
 */
function freezeRefusal(message) {
  return structuralError(message);
}

/**
 * The door a stage or a manual command knocks on: ask, report, and refuse unless this is a dry run.
 *
 * `--dry-run` reports and does not refuse — the prerequisite gate's rule, kept identical so the two
 * gates behave the same way for the same flag.
 *
 * @param {Object} opts
 * @param {string} opts.door
 * @param {string} opts.seriesDir
 * @param {string} opts.cancelledBy
 * @param {string} [opts.detail]
 * @param {string|null} [opts.volumeArg]
 * @param {TranslationTargetVolume[]} [opts.volumes]
 * @param {boolean} [opts.dryRun]
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ok: boolean, reported: boolean, verdict: Object}>}
 * @throws {Error} A structural refusal when the act would rewrite a frozen volume.
 */
async function assertDoorAllowed({ door, seriesDir, cancelledBy, detail, volumeArg = null, volumes = null, dryRun = false, log = console.error }) {
  const verdict = await evaluateFreeze({ door, seriesDir, cancelledBy, detail, volumeArg, volumes });
  if (verdict.ok) return { ok: true, reported: false, verdict };
  if (dryRun) {
    log(`[freeze] ${door} — DRY RUN, so the freeze gate reports and does NOT refuse: ${verdict.frozen.length} volume(s) would be rewritten.`);
    for (const bullet of verdict.bullets) log(`[freeze]   - ${bullet}`);
    return { ok: false, reported: true, verdict };
  }
  throw freezeRefusal(verdict.message);
}

module.exports = {
  FREEZE_DOORS,
  DOOR_OWNER,
  NOT_A_REWRITE,
  MIN_RELEASE_REASON_CHARS,
  RELEASE_RECORD_FILE,
  RELEASE_RECORD_SCHEMA,
  freezeDoorRow,
  frozenDoors,
  requiredTranslationArtifacts,
  readFrozenState,
  readFreezeScope,
  doorArtifacts,
  releaseRecordPath,
  readTranslationReleases,
  releaseCovering,
  recordTranslationRelease,
  evaluateFreeze,
  freezeRefusal,
  assertDoorAllowed,
};
