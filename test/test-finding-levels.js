/**
 * test/test-finding-levels.js — the level table is complete, and every finding carries its level.
 *
 * This is the test `utils/postmortem/plan/01-finding-levels.md` §6 says would have caught §1: a real
 * defect reported in a channel nobody reads. Three things hold it honest:
 *
 *   1. **Completeness.** Every finding kind the repository emits has a row in `FINDING_LEVELS`. The
 *      kinds are enumerated from the source text, so a new kind with no declared level fails the
 *      suite rather than quietly defaulting.
 *   2. **The level is on the finding.** `finding()` looks the kind up and records it, so the level is
 *      decided once, by code, in a closed path — not re-derived by whoever reads the report.
 *   3. **The ratchet on the damage kinds the triage can see.** The plan exists because four kinds the
 *      triage calls damage were emitted at MEDIUM and, with the triage filtering on severity first,
 *      could never reach its decision. Slice 2 routed the triage on the declared level instead, so the
 *      ratchet is now "how many damage kinds never land in the damage list" — and that number is **0**.
 *      The four kinds are pinned separately, still emitted below HIGH, because the failure they
 *      measured was the routing dial and not the severity.
 *
 * The behavioural half — what a level actually does to a plan — is `test/test-finding-routing.js`.
 *
 * Nothing here reads a volume, a database or the endpoint. It reads source text and calls pure
 * functions. (AGENTS.md rule 8, gotcha 69.)
 *
 * @module test/test-finding-levels
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { readModuleLayer } = require("./module-layer");
const { LEVELS, FINDING_LEVELS, levelFor } = require("../utils/postmortem/levels");
const { finding } = require("../utils/postmortem/rules");
const { DAMAGE_KINDS, EVIDENCE_KINDS, classifyFindings } = require("../utils/resume");
const { BANNED_PATCH_PATHS, PROJECT_SOURCE_DIRS } = require("../utils/patches");

const ROOT = path.join(__dirname, "..");

let checks = 0;
/**
 * Count one assertion and run it, so the suite can print how many checks it actually made.
 *
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

// ─── The inventory: which kinds does this repository actually emit? ─────────────

/**
 * Folders the scan never walks: dependencies, git, the plans of record (prose that names kinds is not
 * code that emits them), the tests themselves (a fixture inventing a kind is not the pipeline
 * emitting one), and every generated folder.
 */
const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "plan", "test", ".dry-run", ".run", "epub_source"]);

/**
 * Every `finding(severity, "kind", …)` call in the repository's own source, with the severity
 * expression each one passes.
 *
 * The walk is a tree walk rather than a per-barrel `readModuleLayer` call on purpose: a tree walk
 * follows a module into its folder automatically (AGENTS.md §3) and cannot drift when a new module
 * starts emitting findings. `readModuleLayer` is still used where the guarantee belongs to one
 * module's layer (see the `missing-required` pin below).
 *
 * @returns {Map<string, Array<{expr: string, file: string, line: number}>>} kind → its emission sites.
 */
function emittedKinds() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".js")) files.push(abs);
    }
  })(ROOT);

  /** @type {Map<string, Array<{expr: string, file: string, line: number}>>} */
  const found = new Map();
  for (const abs of files) {
    const source = fs.readFileSync(abs, "utf8");
    const rel = path.relative(ROOT, abs);
    const re = /finding\(\s*([\s\S]{0,200}?)\s*,\s*"([a-z0-9-]+)"/g;
    let m;
    while ((m = re.exec(source))) {
      const kind = m[2];
      const expr = m[1].trim().replace(/\s+/g, " ");
      if (!found.has(kind)) found.set(kind, []);
      found.get(kind).push({ expr, file: rel, line: source.slice(0, m.index).split("\n").length });
    }
  }

  // `missing-required` and `missing-expected` are the two kinds NOT built by a literal kind: assessFile
  // picks the kind and the severity from the expectation's own `level` in one expression. They are
  // pinned against the module that builds them so this list cannot drift away from the code.
  const fileLayer = readModuleLayer(ROOT, "utils/postmortem/file.js", "utils/postmortem");
  for (const kind of ["missing-required", "missing-expected"]) {
    ok(
      fileLayer.includes(`"${kind}"`),
      `"${kind}" must still be built in utils/postmortem/file.js — if it moved, this inventory has to move with it`
    );
    if (!found.has(kind)) found.set(kind, []);
    found.get(kind).push({
      expr: 'expectation.level === "required" ? "HIGH" : "MEDIUM"',
      file: "utils/postmortem/file.js",
      line: 38,
    });
  }
  return found;
}

/**
 * The four kinds whose severity is computed rather than written. Pinned, because a fifth one means a
 * new kind got a severity from somewhere the suite cannot see.
 *
 * `always` is the severity the kind can actually be emitted at, once the expression is read in context.
 */
const DYNAMIC_SEVERITY = {
  "missing-required": {
    always: "HIGH",
    because:
      "the kind and the severity come from one condition: a required expectation is HIGH, and the " +
      "MEDIUM branch produces the kind `missing-expected` instead.",
  },
  "missing-expected": {
    always: "MEDIUM",
    because: "the mirror of `missing-required`: it is the kind the same condition produces when the expectation is not required.",
  },
  "grade-failures": {
    always: null,
    because: "HIGH when every grade attempt was unusable, MEDIUM when only some were.",
  },
  "quarantine-present": {
    always: null,
    because: "the step's own quarantine declaration decides it (HIGH for a cumulative artifact, MEDIUM for a draft).",
  },
};

/**
 * Classify one severity expression as a literal HIGH / MEDIUM / LOW, or as dynamic.
 *
 * @param {string} expr
 * @returns {"HIGH"|"MEDIUM"|"LOW"|"dynamic"}
 */
function severityOf(expr) {
  const s = expr.trim();
  if (s === '"HIGH"') return "HIGH";
  if (s === '"MEDIUM"') return "MEDIUM";
  if (s === '"LOW"') return "LOW";
  return "dynamic";
}

const KINDS = emittedKinds();

/**
 * The severities one kind can be emitted at, across every site that builds it.
 *
 * @param {string} kind
 * @returns {string[]} e.g. ["HIGH"], ["HIGH","MEDIUM"], ["dynamic:HIGH"]
 */
function severitiesFor(kind) {
  const out = new Set();
  for (const site of KINDS.get(kind) || []) {
    const s = severityOf(site.expr);
    if (s !== "dynamic") {
      out.add(s);
      continue;
    }
    const pinned = DYNAMIC_SEVERITY[kind];
    if (pinned && pinned.always) out.add(pinned.always);
    else out.add(`dynamic(${site.expr})`);
  }
  return [...out].sort();
}

/**
 * Whether a kind is provably emitted at HIGH at every site (the requirement for a STOP kind).
 *
 * @param {string} kind
 * @returns {boolean}
 */
function alwaysHigh(kind) {
  return severitiesFor(kind).length === 1 && severitiesFor(kind)[0] === "HIGH";
}

// ─── 1. Completeness ───────────────────────────────────────────────────────────

const declared = Object.keys(FINDING_LEVELS).sort();
const emitted = [...KINDS.keys()].sort();

same(
  emitted.length,
  72,
  `the repository emits 72 finding kinds (70 through finding() plus missing-required / missing-expected); found ${emitted.length}`
);
same(
  declared,
  emitted,
  `every emitted kind needs a row in FINDING_LEVELS.\n  missing a level: ${emitted.filter((k) => !FINDING_LEVELS[k]).join(", ") || "(none)"}\n  declared but never emitted: ${declared.filter((k) => !KINDS.has(k)).join(", ") || "(none)"}`
);

for (const kind of emitted) {
  const row = FINDING_LEVELS[kind];
  ok(LEVELS.includes(row.level), `${kind}: level "${row.level}" is not one of ${LEVELS.join("/")}`);
  ok(
    typeof row.why === "string" && row.why.length > 20,
    `${kind}: a level row has to say how far the damage travels, not just name a level`
  );
  same(row.kind, kind, `${kind}: a row must name the kind it is for`);
}

same(
  LEVELS,
  ["STOP", "MAJOR", "MINOR", "NOTE"],
  "the four levels are the plan's four, in the plan's order (§3)"
);

// The kinds the plan was written for are the slice's whole point: they must be MAJOR, not left at
// whatever the default would have been.
for (const kind of ["wrong-shape", "chapter-without-draft", "accepted-without-acceptance", "audit-verdict-missing"]) {
  same(FINDING_LEVELS[kind].level, "MAJOR", `${kind} is the defect this plan exists for — it must be MAJOR`);
}

// The two kinds the character-voice reading pass reports through the finding channel
// (`character-voice/findings.js`, register plan slice 0). Their levels are the slice's decision, so they
// are pinned here rather than left to whatever the row says today: a MAJOR that quietly became a MINOR
// would stop halting the volume walk, and a MINOR that quietly became a MAJOR would pause a 17-volume run
// over a chapter that came back half an answer.
same(FINDING_LEVELS["voice-chapter-never-answered"].level, "MAJOR", "a voice chapter that never answered is the sibling of the glossary's — every later volume is copied from the record it left a hole in");
same(FINDING_LEVELS["voice-chapter-kept-cut-off"].level, "MINOR", "a voice chapter kept although it came back cut off is investigated, not a pause: the real volume this repository read needed a second paid read on 2 of its 7 chapters");

// ─── 2. The level is on the finding ────────────────────────────────────────────

for (const kind of declared) {
  const f = finding("MEDIUM", kind, "glossary", "01", "glossary.md", `a planted ${kind} for the level test`);
  same(f.level, FINDING_LEVELS[kind].level, `${kind}: finding() must record the declared level`);
  ok(!f.message.includes("level undeclared"), `${kind}: a declared kind must not be reported as undeclared`);
}

const unknown = finding("MEDIUM", "a-kind-nobody-declared", "glossary", "01", "glossary.md", "a planted kind");
same(unknown.level, "MINOR", "an unknown kind falls back to MINOR: investigated, and it does not halt a run");
ok(
  unknown.message.includes('level undeclared for kind "a-kind-nobody-declared"'),
  `an unclassified kind must be visible in the finding's own message, not quietly downgraded; got: ${unknown.message}`
);

// The fallback must not be reachable for a kind the pipeline actually emits.
for (const kind of emitted) {
  const f = finding("MEDIUM", kind, "glossary", "01", "glossary.md", `a planted ${kind}`);
  ok(!f.message.includes("level undeclared"), `${kind}: emitted by the repository, so it must be classified`);
}

// ─── 3. The ratchet on the damage kinds the triage cannot see ─────────────────

/**
 * The kinds `utils/resume/menu.js` calls damage that **cannot reach the triage's damage decision**.
 *
 * It used to be measured through severity: `utils/resume/state.js` filtered on `severity === "HIGH"`
 * first, so a damage kind emitted at MEDIUM was invisible no matter what the menu said about it. Four
 * were. Slice 2 of `utils/postmortem/plan/01-finding-levels.md` replaced that filter with
 * `classifyFindings`, which routes on the declared level — so the honest measurement is no longer
 * "which kinds are emitted below HIGH" but "which kinds never land in the damage list".
 *
 * RATCHET — **this number is 0 and stays 0.** Exact equality is deliberate: whoever makes a damage kind
 * invisible edits this test in the open, and whoever makes one visible edits it too.
 */
const blindDamageKinds = [...DAMAGE_KINDS]
  .filter((k) => classifyFindings([finding("MEDIUM", k, "glossary", "02", "glossary.md", `planted ${k}`)]).damage.length === 0)
  .sort();
same(
  blindDamageKinds,
  [],
  `every one of the ${DAMAGE_KINDS.size} kinds the triage calls damage must reach its decision, whatever severity it is emitted at`
);

/**
 * The four kinds §1 was written about, pinned as still being emitted below HIGH.
 *
 * They stay pinned because the blindness they measured was a ROUTING failure, not a severity failure:
 * quietly raising all four to HIGH would satisfy the old test while leaving the triage routing on the
 * wrong dial. What makes them visible is the level, and the assertion above is the one that proves it.
 */
const emittedBelowHigh = [...DAMAGE_KINDS].filter((k) => !alwaysHigh(k)).sort();
same(
  emittedBelowHigh,
  ["accepted-without-acceptance", "audit-verdict-missing", "chapter-without-draft", "wrong-shape"],
  `these 4 of the ${DAMAGE_KINDS.size} damage kinds are still emitted below HIGH — which is the exact shape that made them invisible when the triage filtered on severity, and why it routes on level instead`
);

// And each of the four is routed to damage by level, at the severity it is really emitted at.
for (const kind of emittedBelowHigh) {
  const routed = classifyFindings([finding("MEDIUM", kind, "glossary", "02", "glossary.md", `planted ${kind}`)]);
  same(routed.damage.map((f) => f.kind), [kind], `${kind} is now reachable: it lands in the damage list at MEDIUM`);
  same(routed.notes, [], `${kind} is no longer a line in a report nobody acts on`);
}

// Every damage kind must have a level, and no damage kind may be a NOTE: a NOTE is "report only",
// which is the exact thing this plan exists to stop.
for (const kind of DAMAGE_KINDS) {
  ok(FINDING_LEVELS[kind], `${kind} is damage and must have a declared level`);
  ok(
    FINDING_LEVELS[kind].level !== "NOTE",
    `${kind} is damage: a NOTE level would put it back in the channel nobody reads`
  );
}
for (const kind of EVIDENCE_KINDS) {
  same(FINDING_LEVELS[kind].level, "NOTE", `${kind} is evidence a gate left behind, not damage — it is reported, never rebuilt`);
}

// Fail closed: a kind the table does not declare is damage, because the default (MINOR) is the one
// level the triage may batch without opening the run.
const undeclared = classifyFindings([finding("MEDIUM", "a-kind-nobody-declared", "glossary", "02", "glossary.md", "planted")]);
same(undeclared.damage.map((f) => f.kind), ["a-kind-nobody-declared"], "an undeclared kind is damage, never a batched gap");
same(undeclared.gaps, [], "and it is not swept into the MINOR batch the default level would have hidden it in");

// ─── 4. STOP means it really stops ─────────────────────────────────────────────

const stopKinds = declared.filter((k) => FINDING_LEVELS[k].level === "STOP");
for (const kind of stopKinds) {
  ok(
    alwaysHigh(kind),
    `${kind} is declared STOP, so it must be emitted at HIGH today — a STOP that arrives as a MEDIUM is a halt that cannot fire`
  );
}
ok(stopKinds.length > 0, "the table declares at least one STOP kind");

// A severity expression nobody pinned: a new kind with a computed severity is a new place the level
// and the severity can disagree without the suite noticing.
const dynamicKinds = emitted.filter((k) => (KINDS.get(k) || []).some((s) => severityOf(s.expr) === "dynamic")).sort();
same(dynamicKinds, Object.keys(DYNAMIC_SEVERITY).sort(), "only the three pinned kinds may compute their severity");

// ─── 5. The table is data in a closed path ─────────────────────────────────────

/**
 * The level table is data in a path the dev team may not edit, so the role being investigated cannot
 * re-grade the finding it is investigated for (plan §6, `AGENTS.md` rule 3).
 *
 * This assertion was a pinned GAP when slice 1 was built: `BANNED_PATCH_PATHS` covered tickets / resume /
 * delivery-verify / ledger / runlock / patches / reference-store and **not** `utils/postmortem/`, which
 * meant the plan's premise was false and the table the plan asked for landed in an open path. Closed by
 * adding `postmortem` to the constraint-tables pattern.
 *
 * The test that pins the table is closed to the same role: a guard whose proof is editable by the role it
 * judges is decoration (gotcha 67).
 */
const banCoversLevelsFile = BANNED_PATCH_PATHS.filter((r) => r.pattern && r.pattern.test("utils/postmortem/levels.js")).map((r) => r.id);
same(banCoversLevelsFile, ["constraint-tables"], "the level table must live in a banned patch path — the investigated role cannot re-grade its own finding");
ok(
  PROJECT_SOURCE_DIRS.includes("utils/"),
  "utils/ is patchable source, which is what makes the assertion above a guard rather than a formality"
);
const banCoversThisTest = BANNED_PATCH_PATHS.filter((r) => r.pattern && r.pattern.test("test/test-finding-levels.js")).map((r) => r.id);
same(banCoversThisTest, ["constraint-tests"], "the test that pins the level table is itself closed to the role it judges");

// ─── 6. No environment knob ────────────────────────────────────────────────────

const levelsSource = fs.readFileSync(path.join(ROOT, "utils/postmortem/levels.js"), "utf8");
ok(!levelsSource.includes("process.env"), "levels.js must read no environment variable: a guard the role can switch off is not a guard (rule 3, gotcha 70)");
ok(!/require\(/.test(levelsSource.replace(/^\s*\/\/.*$/gm, "")), "levels.js is a table, not a consumer — it requires nothing");

// The level must survive into the JSON report, which is the half a later diagnosis agent reads.
const reportSource = readModuleLayer(ROOT, "utils/postmortem/render.js", "utils/postmortem");
ok(/findings:\s*report\.findings/.test(reportSource), "the JSON report serialises findings wholesale, so `level` reaches it with no extra wiring");

console.log(`OK: ${checks} checks on the finding level table — ${emitted.length} kinds, ${LEVELS.join("/")}.`);
for (const level of LEVELS) {
  const group = declared.filter((k) => FINDING_LEVELS[k].level === level);
  console.log(`  ${level.padEnd(6)} ${group.length}`);
}
