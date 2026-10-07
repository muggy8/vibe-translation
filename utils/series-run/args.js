/**
 * The command line every task reads.
 *
 * Seven tasks used to parse `process.argv` themselves, and the seven copies had already drifted:
 * one reported "No volume matching --volume null" when the manifest was simply empty, another
 * forgot `--chunked` entirely. The flags are the account owner's contract with the pipeline, so
 * they are read once, in one place, the same way for every stage.
 *
 * Part of the series-run layer (utils/series-run.js).
 */

/**
 * @typedef {Object} RunArgs
 * @property {boolean} dryRun - `--dry-run`: no model calls, prompts dumped to `.dry-run/`.
 * @property {boolean} force - `--force`: regenerate even when the outputs already pass.
 * @property {boolean} chunked - `--chunked`: force the chapter-by-chapter path.
 * @property {string|null} volumeArg - The `--volume NN` value, or null for a whole-series run.
 */

/**
 * Read the pipeline's run flags from an argv array.
 *
 * `--volume` is accepted in both shapes the account owner uses (`--volume 01` and
 * `--volume=01`). A bare `--volume` with nothing after it is `null`, not `undefined`, so
 * every caller can branch on one value.
 *
 * @param {string[]} [argv] - The argument array. Defaults to `process.argv`.
 * @returns {RunArgs}
 */
function readRunArgs(argv = process.argv) {
  const volumeArg =
    (argv.find((a) => a.startsWith("--volume=")) || "").replace("--volume=", "") ||
    (argv.includes("--volume") ? argv[argv.indexOf("--volume") + 1] || null : null);
  return {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    chunked: argv.includes("--chunked"),
    volumeArg: volumeArg || null,
  };
}

module.exports = { readRunArgs };
