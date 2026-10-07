/**
 * utils/delivery-verify/read.js — reading a file for measurement, keeping the three outcomes apart.
 *
 * Absent, unreadable and too-big are three different facts, and collapsing them
 * into "empty" reports a permissions problem as a loss of content — the
 * direction of error that gets accepted work deleted. The counting helpers are
 * plain counts, deliberately: this is a measurement of the deliverable, not a
 * carry-forward gate, and the gates are not re-implemented here.
 */

const fs = require("fs").promises;

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

module.exports = {
  READ_CAP_BYTES,
  readForMeasurement,
  readJsonForMeasurement,
  countHeadings,
  countBulletRules,
};
