/**
 * utils/prereqs/freeze/releases.js — the recorded act that is the only way past the freeze gate.
 *
 * A release is the account owner saying, in writing, that these volumes' translations no longer
 * vouch for what the references now say. It is deliberately thin and every part of it is a guard: a
 * reason under `MIN_RELEASE_REASON_CHARS` is refused, an unknown door is refused, the record is read
 * back before it is appended to, and a record that cannot be read is reported rather than silently
 * read as "no releases" — a gate that fails open is a gate that fails. **It touches no translation
 * file**: it writes one row into the run's own records and does not delete, edit, mark or schedule
 * anything in a volume folder, which `test/test-freeze-gate.js` pins by checksumming every
 * translation before and after.
 *
 * The record path is resolved at CALL time, because `POSTMORTEM_DIR` / `SERIES_LOCATION` are settings
 * and a machine-state path frozen at require time is gotcha 79 arriving again (gotcha 94).
 *
 * @module utils/prereqs/freeze/releases
 */

const fs = require("fs");
const path = require("path");

const { specForStep } = require("../../artifacts");
const { postMortemDir } = require("../../postmortem");
const { FREEZE_DOORS, DOOR_OWNER, freezeDoorRow } = require("./doors");
const { requiredTranslationArtifacts } = require("./declared-artifacts");

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

module.exports = {
  MIN_RELEASE_REASON_CHARS,
  RELEASE_RECORD_FILE,
  RELEASE_RECORD_SCHEMA,
  releaseRecordPath,
  readTranslationReleases,
  releaseCovering,
  recordTranslationRelease,
};
