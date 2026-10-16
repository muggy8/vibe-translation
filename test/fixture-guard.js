/**
 * test/fixture-guard.js — the one rule about where a fixture may be built.
 *
 * Both fixture builders (`test/fixture-series.js` for the delivery layer, `test/fixture-reference-store.js`
 * for the reference store) write a whole fake series onto disk, and both of them `rm -rf` the folder they
 * are about to write into. A root that points at the corpus is therefore not a misplaced fixture, it is a
 * command that deletes books — which is exactly the shape gotcha 172 describes, a scratch folder that
 * landed on the thing it was copying.
 *
 * `test/test-home.js` pins the same rule for a suite's RECORDS folder. This pins it for a suite's FIXTURE
 * folder, and it is the door `test/runner.js` walks through when it hands every suite its own root.
 *
 * A leaf: it requires nothing but `fs` and `path`, so either helper can use it without pulling the other
 * one's dependency graph along.
 *
 * @module test/fixture-guard
 */

const path = require("path");

/** The shared default root, unchanged from before the runner existed. */
const FIXTURES_ROOT_DEFAULT = path.resolve("/tmp/opencode/series-fixtures");

/**
 * The variable `test/runner.js` sets to give each suite a root of its own.
 *
 * Unset means "a person ran this suite by hand", and the shared default is used, exactly as today.
 */
const FIXTURES_ROOT_ENV = "AI_CLIENT_TEST_FIXTURES_ROOT";

/**
 * Is `child` the same folder as `parent` or inside it?
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Refuse a fixture root the corpus could be.
 *
 * @param {string} root - The folder a fixture is about to be built in.
 * @returns {string} The resolved root, when it is safe.
 * @throws {Error} When it is inside `SERIES_LOCATION`, or inside this repository's default source folder
 *   (`epub_source/`, which is `SERIES_LOCATION` when nothing else is set — configs/env-defaults.js).
 */
function assertSafeFixturesRoot(root) {
  const absolute = path.resolve(root);
  const series = (process.env.SERIES_LOCATION || "").trim();
  if (series && isInside(series, absolute)) {
    throw new Error(
      `test/fixture-guard.js: the fixture root "${absolute}" is inside SERIES_LOCATION (${series}). ` +
        `A fixture builder rm -rf's the folder it writes into, so this root would let a suite delete ` +
        `the corpus it is testing (AGENTS.md rule 8, gotcha 69).`
    );
  }
  const defaultSource = path.resolve(__dirname, "..", "epub_source");
  if (isInside(defaultSource, absolute)) {
    throw new Error(
      `test/fixture-guard.js: the fixture root "${absolute}" is inside this repository's default source ` +
        `folder (${defaultSource}), which holds books, not fixtures.`
    );
  }
  return absolute;
}

/**
 * Pick the folder a fixture is built in.
 *
 *   1. No root passed — this process's own root (`AI_CLIENT_TEST_FIXTURES_ROOT`), or the shared default.
 *   2. A root that IS the shared default — read as "I did not pick one", so the per-suite root wins.
 *      Suites that spell the shared default out themselves are the reason this case exists: it isolates
 *      them without editing every one of them.
 *   3. Any other root — the caller's, unchanged.
 *
 * @param {string} [root] - The caller's root, if it named one.
 * @returns {string} The resolved, guarded root.
 */
function resolveFixturesRoot(root) {
  const override = (process.env[FIXTURES_ROOT_ENV] || "").trim();
  const chosen =
    root === undefined
      ? override || FIXTURES_ROOT_DEFAULT
      : path.resolve(root) === FIXTURES_ROOT_DEFAULT && override
        ? override
        : path.resolve(root);
  return assertSafeFixturesRoot(chosen);
}

module.exports = {
  FIXTURES_ROOT_DEFAULT,
  FIXTURES_ROOT_ENV,
  isInside,
  assertSafeFixturesRoot,
  resolveFixturesRoot,
};
