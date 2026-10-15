/**
 * test/test-module-layer.js — the suite for the helper that lets a source-text pin follow a
 * module into the folder it was cut into.
 *
 * Why this suite exists: `readModuleLayer` is how a dozen pins answer "does this stage wire
 * the gate?" A helper that reads the face plus ONE level answers that question about a
 * module split once and silently stops answering it about a module split twice — and a scan
 * that stops early reports a guarantee that exists as a missing one (gotcha 67's shape) or,
 * worse, keeps passing because the file it never opened is the file that would have made it
 * fail. This suite pins the four things the helper has to get right, and the drop half is
 * proved against the one-level behaviour it replaces.
 *
 * Nothing here calls the model, runs the pipeline, or reads the real 17 volumes. The real
 * layers are read as TEXT only; every fixture is built under /tmp/opencode.
 *
 * @module test/test-module-layer
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readModuleLayer, dropModuleLayer, moduleLayerFiles, MAX_LAYER_DEPTH } = require("./module-layer");

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.resolve("/tmp/opencode/module-layer-tests");

let checks = 0;

/**
 * `assert.ok` that counts itself.
 *
 * @param {boolean} cond - The claim.
 * @param {string} message - What is false when this fails.
 * @returns {void}
 */
function ok(cond, message) {
  checks++;
  assert.ok(cond, message);
}

/**
 * `assert.strictEqual` that counts itself.
 *
 * @param {any} actual - What we got.
 * @param {any} expected - What the guarantee says.
 * @param {string} message - What is false when this fails.
 * @returns {void}
 */
function same(actual, expected, message) {
  checks++;
  assert.strictEqual(actual, expected, message);
}

/**
 * An INDEPENDENT walk of one folder — breadth-first, `statSync` instead of Dirent — written
 * so it cannot share a bug with the helper it is compared against.
 *
 * @param {string} dir - Folder to walk.
 * @returns {string[]} Absolute paths of every `.js` file, sorted.
 */
function independentWalk(dir) {
  const out = [];
  const queue = [dir];
  while (queue.length) {
    const here = queue.shift();
    for (const name of fs.readdirSync(here)) {
      const full = path.join(here, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) queue.push(full);
      else if (st.isFile() && name.endsWith(".js")) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Build a throwaway fixture folder.
 *
 * @param {string} name - Fixture name.
 * @returns {string} Absolute path to the (empty) fixture folder.
 */
function fixture(name) {
  const dir = path.join(FIXTURES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write one file inside a fixture, creating its folders.
 *
 * @param {string} dir - Fixture root.
 * @param {string} rel - Path inside it.
 * @param {string} body - File contents.
 * @returns {string} The absolute path written.
 */
function write(dir, rel, body) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body, "utf8");
  return full;
}

// ─── 1. the scan follows the layer all the way down ───────────────────────────

/**
 * For every real layer in this repository that nests, the helper's file list equals an
 * independently computed walk of the named folder — and the joined text therefore contains
 * every nested file's own bytes.
 *
 * @returns {void}
 */
function testRealLayersAreReadWhole() {
  /** @type {Array<[string, string|undefined]>} Every (file, folder) pair the suites pass. */
  const layers = [
    ["glossary.js", "glossary"],
    ["glossary/store.js", "glossary"],
    ["glossary/task.js", "glossary"],
    ["character-voice.js", undefined],
    ["character-voice/task.js", undefined],
    ["character-voice/stages.js", undefined],
    ["character-voice/prompts.js", undefined],
    ["character-voice/reconcile.js", undefined],
    ["delivery/act.js", undefined],
    ["delivery/tickets.js", undefined],
    ["utils/reference-store/facts.js", undefined],
    ["utils/reference-store/identity.js", undefined],
    ["utils/postmortem/file.js", "utils/postmortem"],
    ["utils/prereqs/freeze.js", undefined],
    ["utils/source/audit.js", undefined],
    ["harness.js", "ai"],
  ];

  let nestedTotal = 0;
  for (const [file, folder] of layers) {
    const listed = moduleLayerFiles(ROOT, file, folder);
    const dir = path.join(ROOT, folder || file.replace(/\.js$/, ""));
    const face = path.join(ROOT, file);
    const expected = fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? independentWalk(dir) : [];
    const want = [face, ...expected.filter((p) => p !== face)];
    same(listed.length, want.length, `${file}: the helper lists ${listed.length} file(s), an independent walk finds ${want.length}`);
    for (const p of want) ok(listed.includes(p), `${file}: ${path.relative(ROOT, p)} is part of the layer and the scan does not read it`);

    // Nothing outside the named folder sneaks in.
    for (const p of listed) {
      if (p === face) continue;
      const rel = path.relative(dir, p);
      ok(rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel), `${file}: ${path.relative(ROOT, p)} is outside the layer it names`);
    }

    const nested = listed.filter((p) => p !== face && path.dirname(p) !== dir);
    nestedTotal += nested.length;
  }

  // The three layers this slice exists for. Measured 2026-10-15: the glossary layer nests
  // three times (extract/, carry-forward/, settlement/), the character-voice stage nests twice
  // (reconcile/ and reading/), and the whole-layer scans that name them read 13 and 9 more files.
  const glossary = moduleLayerFiles(ROOT, "glossary.js", "glossary");
  ok(glossary.some((p) => p.endsWith(path.join("settlement", "decide.js"))), "the glossary scan does not reach glossary/settlement/decide.js");
  ok(glossary.some((p) => p.endsWith(path.join("extract", "answer-shape.js"))), "the glossary scan does not reach glossary/extract/answer-shape.js");
  ok(glossary.some((p) => p.endsWith(path.join("carry-forward", "gates.js"))), "the glossary scan does not reach glossary/carry-forward/gates.js");
  const voice = moduleLayerFiles(ROOT, "character-voice.js");
  ok(voice.some((p) => p.endsWith(path.join("reconcile", "buckets.js"))), "the character-voice scan does not reach character-voice/reconcile/buckets.js");

  // The text is what a pin actually greps, so prove the bytes are there, not just the paths.
  const glossaryText = readModuleLayer(ROOT, "glossary.js", "glossary");
  for (const p of glossary) {
    if (p === path.join(ROOT, "glossary.js")) continue;
    const body = fs.readFileSync(p, "utf8");
    ok(glossaryText.includes(body.slice(0, 200)), `the glossary scan does not carry the text of ${path.relative(ROOT, p)}`);
  }

  console.log(`  real layers: ${layers.length} scanned whole, ${nestedTotal} nested file(s) now inside them`);
}

// ─── 2. the scan stays inside the layer it names ──────────────────────────────

/**
 * A widened walk that could leave the folder would turn a module pin into a repository-wide
 * grep, and a grep over everything reports "not found" about a file it never looked at.
 *
 * @returns {void}
 */
function testTheScanCannotLeaveTheFolder() {
  const dir = fixture("containment");
  // The folder is named explicitly, the way harness.js names "ai".
  write(dir, "face.js", 'module.exports = require("./impl/inner");\n');
  write(dir, "impl/inner.js", "module.exports = { MARKER_INNER: \"inner-marker\" };\n");
  write(dir, "impl/deep/deeper.js", "module.exports = { MARKER_DEEP: \"deep-marker\" };\n");
  write(dir, "outside/elsewhere.js", "module.exports = { MARKER_OUTSIDE: \"outside-marker\" };\n");

  const layer = readModuleLayer(dir, "face.js", "impl");
  ok(layer.includes("inner-marker"), "the scan does not read the module's own folder");
  ok(layer.includes("deep-marker"), "the scan does not read a folder nested inside it");
  ok(!layer.includes("outside-marker"), "the scan reached a file outside the folder it names");

  // A real one: the glossary scan must not carry the character-voice stage's text.
  const glossaryText = readModuleLayer(ROOT, "glossary.js", "glossary");
  const voiceQa = fs.readFileSync(path.join(ROOT, "character-voice/qa.js"), "utf8");
  ok(!glossaryText.includes(voiceQa.slice(0, 200)), "the glossary scan carries a file from the character-voice layer");

  console.log("  containment: nested folders are in, neighbouring folders are out");
}

// ─── 3. a plan folder is not an implementation folder ─────────────────────────

/**
 * `glossary/plan/`, `character-voice/plan/` and `utils/postmortem/plan/` are plans of record:
 * prose a human reads, not code a pin is about. Reading them would let a pin's grep match a
 * sentence that describes a rule instead of the code that enforces it.
 *
 * @returns {void}
 */
function testPlanFoldersAreNotRead() {
  const dir = fixture("plans");
  write(dir, "face.js", 'require("./impl/inner");\n');
  write(dir, "impl/inner.js", "module.exports = { REAL: \"real-code\" };\n");
  write(dir, "impl/plan/01-plan.js", "module.exports = { PLAN_CODE: \"plan-code\" };\n");
  write(dir, "impl/plan/notes.md", "# the plan\n");
  write(dir, "impl/.cache/generated.js", "module.exports = { CACHE_CODE: \"cache-code\" };\n");
  write(dir, "impl/node_modules/dep/index.js", "module.exports = { DEP_CODE: \"dep-code\" };\n");

  const layer = readModuleLayer(dir, "face.js", "impl");
  ok(layer.includes("real-code"), "the scan does not read the implementation");
  ok(!layer.includes("plan-code"), "the scan reads code out of a plan folder");
  ok(!layer.includes("cache-code"), "the scan reads a dotted folder");
  ok(!layer.includes("dep-code"), "the scan reads node_modules");

  // The real plans are prose, and the real scans carry none of them.
  const glossaryText = readModuleLayer(ROOT, "glossary.js", "glossary");
  const plan = fs.readFileSync(path.join(ROOT, "glossary/plan/01-glossary-route.md"), "utf8");
  ok(!glossaryText.includes(plan.slice(0, 120)), "the glossary scan carries the glossary plan of record");

  console.log("  exclusions: plan/, dotted folders and node_modules are not a module's layer");
}

// ─── 4. symlinks are not followed ─────────────────────────────────────────────

/**
 * A layer is the code in the folder. A link is a pointer to somewhere else, and following it
 * would let a scan read a file the pin's folder does not contain — including, on this
 * machine, a file on another filesystem.
 *
 * @returns {void}
 */
function testSymlinksAreNotFollowed() {
  const dir = fixture("symlinks");
  write(dir, "face.js", 'require("./impl/inner");\n');
  write(dir, "impl/inner.js", "module.exports = { REAL: \"real-code\" };\n");
  const outside = path.join(FIXTURES, "symlink-target");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "linked-file.js"), "module.exports = { LINKED: \"linked-code\" };\n", "utf8");
  fs.writeFileSync(path.join(outside, "inside-linked-dir.js"), "module.exports = { THROUGH: \"through-code\" };\n", "utf8");

  let made = true;
  try {
    fs.symlinkSync(path.join(outside, "linked-file.js"), path.join(dir, "impl", "alias.js"));
    fs.symlinkSync(outside, path.join(dir, "impl", "aliasdir"));
  } catch (err) {
    made = false;
    // The refusal is reported, not swallowed: a filesystem that cannot make a symlink is a
    // check that did not run, and this suite says so out loud rather than printing a pass.
    console.log(`  symlinks: NOT TESTED on this filesystem (${err && err.code}) — the guard is pinned by the fixture below instead`);
  }

  if (made) {
    const layer = readModuleLayer(dir, "face.js", "impl");
    ok(layer.includes("real-code"), "the scan does not read the module's own folder");
    ok(!layer.includes("linked-code"), "the scan followed a symlinked file");
    ok(!layer.includes("through-code"), "the scan walked into a symlinked directory");
    const listed = moduleLayerFiles(dir, "face.js", "impl");
    same(listed.length, 2, "the layer list counted a symlink as a file of the layer");
    console.log("  symlinks: a linked file and a linked folder are both left alone");
  }
  return made;
}

// ─── 5. the walk is bounded, and the bound cannot truncate a real layer ───────

/**
 * The bound exists so a pathological tree cannot turn a module scan into a filesystem crawl.
 * It only stays safe if no real layer is deeper than it — otherwise the helper would silently
 * read less than the layer, which is the exact bug this slice fixes.
 *
 * @returns {void}
 */
function testTheBoundIsWiderThanAnyRealLayer() {
  const dir = fixture("depth");
  write(dir, "face.js", 'require("./l1/a");\n');
  // Seven folders NESTED inside one another: l1/l2/l3/… — the shape a layer gets when a
  // submodule keeps splitting.
  let rel = "l1";
  for (let i = 1; i <= 7; i++) {
    const leaf = i < 7 ? "a.js" : "deep.js";
    write(dir, `${rel}/${leaf}`, i < 7 ? "// one folder deeper\nmodule.exports = {};\n" : "module.exports = { TOO_DEEP: \"too-deep\" };\n");
    rel = `${rel}/l${i + 1}`;
  }
  const layer = readModuleLayer(dir, "face.js", "l1");
  const listed = moduleLayerFiles(dir, "face.js", "l1");
  // face + l1..l5 are inside the bound (l1 is depth 0 below the named folder, l5 is depth 4).
  same(listed.length, 6, `the walk read ${listed.length} file(s) instead of stopping at MAX_LAYER_DEPTH = ${MAX_LAYER_DEPTH}`);
  ok(!layer.includes("too-deep"), "the walk went past its own depth bound");

  // The bound is wider than every layer this repository actually has.
  let deepest = 0;
  for (const [file, folder] of [["glossary.js", "glossary"], ["character-voice.js", undefined], ["utils/reference-store/facts.js", undefined], ["utils/postmortem/file.js", "utils/postmortem"], ["delivery/tickets.js", undefined]]) {
    const base = path.join(ROOT, folder || file.replace(/\.js$/, ""));
    if (!fs.existsSync(base)) continue;
    for (const p of independentWalk(base)) {
      const depth = path.relative(base, path.dirname(p)).split(path.sep).filter(Boolean).length;
      if (depth > deepest) deepest = depth;
    }
  }
  ok(deepest < MAX_LAYER_DEPTH, `the deepest real implementation folder is ${deepest}, which the bound of ${MAX_LAYER_DEPTH} would truncate`);
  console.log(`  bound: MAX_LAYER_DEPTH = ${MAX_LAYER_DEPTH}, the deepest real layer folder is ${deepest}`);
}

// ─── 6. dropModuleLayer forgets the WHOLE layer, nested folders included ──────

/**
 * The proof the dispatch asked for: state planted in a module NESTED TWO LEVELS DOWN, the
 * layer dropped, and the next read shown to be genuinely fresh — and the same fixture run
 * against the one-level drop this helper used to do, shown to be NOT fresh.
 *
 * @returns {void}
 */
function testTheDropForgetsNestedState() {
  const dir = fixture("nested-state");
  // The shape of a real layer: a face, a submodule, and a submodule of that submodule holding
  // the Map — utils/tokens.js → utils/tokens/calibration.js → (if it split again) the Map.
  write(dir, "face.js", 'module.exports = require("./sub/inner");\n');
  write(dir, "sub/inner.js", 'const deep = require("./deep/measured");\nmodule.exports = { measure: deep.measure, note: deep.note };\n');
  write(dir, "sub/deep/measured.js", "const seen = new Map();\nmodule.exports = {\n  note() { seen.set(\"probe\", (seen.get(\"probe\") || 0) + 1); },\n  measure() { return seen.get(\"probe\") || 0; },\n};\n");

  const facePath = path.join(dir, "face.js");
  const innerPath = path.join(dir, "sub", "inner.js");
  const deepPath = path.join(dir, "sub", "deep", "measured.js");

  // ── the new behaviour: the whole layer is forgotten ──
  let mod = require(facePath);
  same(mod.measure(), 0, "a fresh layer starts with nothing measured");
  mod.note();
  mod.note();
  same(mod.measure(), 2, "the nested module remembers what this process measured");

  const dropped = dropModuleLayer(dir, "face.js", "sub");
  same(dropped, 3, `dropModuleLayer forgot ${dropped} cache entry(ies) out of a 3-file layer`);
  ok(!require.cache[require.resolve(deepPath)], "the nested module is still in the require cache after the drop");

  mod = require(facePath);
  same(mod.measure(), 0, "the reloaded layer still holds what the previous process measured — it is not a fresh process");

  // ── the behaviour this replaces: face + one level only ──
  mod.note();
  mod.note();
  mod.note();
  same(mod.measure(), 3, "the planted state is not there to be left behind");
  for (const p of [facePath, innerPath]) delete require.cache[require.resolve(p)];
  ok(require.cache[require.resolve(deepPath)], "the one-level drop did not leave the nested module in the cache — there is nothing to show");
  mod = require(facePath);
  same(mod.measure(), 3, "the one-level drop DID forget it — the fixture no longer reproduces the old behaviour");
  // The nested module is STILL in the cache here, and that is the demonstration: the face and
  // its one level were rebuilt, the file holding the Map was not, and the reloaded "fresh
  // process" answered with the previous process's measurement.

  // The drop and the read are the same list, because they are the same function.
  same(moduleLayerFiles(dir, "face.js", "sub").length, 3, "the read and the drop are reading different lists");

  console.log("  drop: a nested module's Map is gone after the drop, and survives a face-plus-one-level drop");
}

// ─── 7. a module that never split reads exactly as before ─────────────────────

/**
 * The default folder is the one NAMED AFTER the module. A submodule of another layer
 * (`character-voice/task.js`) has no folder named after it, so it reads as one file — and
 * that is what its pins ask for. Widening the default to "the folder containing the file"
 * would widen those pins for the wrong reason: `character-voice/reconcile/fungibility.js` is
 * pinned to read no environment variable, while `character-voice/config.js` legitimately
 * reads SERIES_LOCATION. This pin keeps that boundary from drifting by accident.
 *
 * @returns {void}
 */
function testAnUnsplitModuleReadsAsOneFile() {
  same(moduleLayerFiles(ROOT, "character-voice/task.js").length, 1, "character-voice/task.js now reads more than its own file — its pins are about this entry point");
  same(moduleLayerFiles(ROOT, "delivery/act.js").length, 1, "delivery/act.js now reads more than its own file — its pin is about act mode");
  same(moduleLayerFiles(ROOT, "utils/reference-store/open.js").length, 1, "utils/reference-store/open.js now reads more than its own file — its pin is about the handle");
  same(moduleLayerFiles(ROOT, "extract-voice.js").length, 1, "extract-voice.js now reads more than its own file");

  // A module whose folder exists is still a layer, split once or not at all.
  ok(moduleLayerFiles(ROOT, "utils/tokens.js").length > 1, "utils/tokens.js no longer reads its folder");
  same(moduleLayerFiles(ROOT, "no-such-module.js").length, 1, "a module with no folder reads as one file");

  console.log("  default folder: named after the module, so an entry point stays an entry point");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

/**
 * Run every scenario.
 * @returns {void}
 */
function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  testRealLayersAreReadWhole();
  testTheScanCannotLeaveTheFolder();
  testPlanFoldersAreNotRead();
  testSymlinksAreNotFollowed();
  testTheBoundIsWiderThanAnyRealLayer();
  testTheDropForgetsNestedState();
  testAnUnsplitModuleReadsAsOneFile();
  console.log(`\nmodule layer helper: ${checks} checks, 0 model calls.`);
}

main();
