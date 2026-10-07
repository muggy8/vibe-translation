/**
 * test/calibrate.js — measure the graders.
 *
 * Every quality decision in this pipeline rests on a number a model produces:
 * a chapter passes at 70, an artifact is accepted at 70, a polish is kept at 70.
 * Nothing in the pipeline measured whether those numbers MEAN anything. A grader
 * that hands out 92 for a chapter that dropped its plot point is not a strict
 * grader; it is a rubber stamp, and every gate downstream of it is decoration.
 *
 * This fixture is the measurement. Each case is a short source text with a KNOWN
 * defect in one translation and a faithful rendering in the other. The verifier
 * is run over both, with the production prompt and the production rubric
 * (`gradeChapter` / `buildVerifyPrompt` — the same functions the verify task
 * calls, so this measures the real grader and not an imitation of it).
 *
 * What has to hold:
 *   - the flawed text scores BELOW the clean one (the grader ranks them);
 *   - a defect that changes meaning scores below the passing line (the grader
 *     actually stops it, not merely notices it);
 *   - the gap is big enough that noise near the line cannot flip the outcome.
 *
 * It also keeps its own history: the previous run's scores are printed as a
 * delta, so a grader drifting softer shows up here as a changed distribution
 * instead of as a mystery in production six volumes later.
 *
 * LIVE: this calls the configured VERIFY_* endpoint. It is NOT part of `npm test`.
 *   npm run calibrate
 *   npm run calibrate -- --case 02-meaning-flip
 */
const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");

const { PASSING_SCORE, judgeTemperature } = require("../configs/shared");
const { roleEndpoint, describeEndpoint, medianScore } = require("../utils/translate");

const CAL_DIR = __dirname;
const CASES_FILE = path.join(CAL_DIR, "calibration", "cases.json");
const REPORT_MD = path.join(CAL_DIR, "calibration", "calibration-report.md");
const REPORT_JSON = path.join(CAL_DIR, "calibration", "calibration-report.json");

/** The rubric bands from the acceptance / verification prompts. */
function bandOf(score) {
  if (score === null || score === undefined) return "unparseable";
  if (score >= 85) return "Pass";
  if (score >= 70) return "Pass with minor edits";
  if (score >= 40) return "Requires revision";
  return "Reject";
}

/**
 * Read one case's three files.
 *
 * @param {string} caseId
 * @returns {Promise<{source: string, clean: string, flawed: string}>}
 */
async function readCase(caseId) {
  const dir = path.join(CAL_DIR, "calibration", "cases", caseId);
  const read = async (name) => (await fs.readFile(path.join(dir, name), "utf8")).trim();
  return { source: await read("source.md"), clean: await read("clean.md"), flawed: await read("flawed.md") };
}

/**
 * Grade one text with the production verifier.
 *
 * @param {{id: string, title: string, glossary?: Array<{term: string, rendering: string, section: string}>}} meta
 * @param {{source: string, draft: string}} text
 * @param {Object} deps - { gradeChapter, systemPrompt, template, endpoint }
 * @param {string} variant - "clean" | "flawed" (goes into the log label)
 * @returns {Promise<{score: number|null, band: string, findings: string, disputes: Array<Object>}>}
 */
async function gradeOne(meta, text, deps, variant) {
  const refs = {
    terms: meta.glossary || [],
    styleRules: "",
    background: "",
  };
  const graded = await deps.gradeChapter({
    volume: { installmentNumber: "calibration" },
    systemPrompt: deps.systemPrompt,
    template: deps.template,
    endpoint: deps.endpoint,
    sourceText: text.source,
    draft: text.draft,
    refs,
    label: `calibrate-${meta.id}-${variant}`,
    temperature: judgeTemperature(),
  });
  return {
    score: graded.score,
    band: bandOf(graded.score),
    findings: graded.findings || "",
    disputes: graded.disputes || [],
  };
}

/**
 * The verdict for one case, against its own expectations.
 *
 * @param {Object} meta - The case entry from cases.json
 * @param {{clean: Object, flawed: Object}} results
 * @returns {{ok: boolean, problems: string[], gap: number|null}}
 */
function judgeCase(meta, results) {
  const problems = [];
  const cleanScore = results.clean.score;
  const flawedScore = results.flawed.score;
  const gap = cleanScore !== null && flawedScore !== null ? cleanScore - flawedScore : null;

  if (cleanScore === null) problems.push("the CLEAN text scored nothing — the grader could not be parsed");
  else if (meta.cleanMustPass && cleanScore < PASSING_SCORE) {
    problems.push(`the CLEAN text scored ${cleanScore} — below the passing line (${PASSING_SCORE}). A grader that fails a faithful translation is not grading translation.`);
  }
  if (flawedScore === null) problems.push("the FLAWED text scored nothing — the grader could not be parsed");
  else if (meta.flawedMustFail && flawedScore >= PASSING_SCORE) {
    problems.push(`the FLAWED text scored ${flawedScore} — at or above the passing line (${PASSING_SCORE}). The defect is "${meta.defect}" and the pipeline would publish it.`);
  }
  if (gap !== null && gap < meta.minGap) {
    problems.push(`the gap between clean and flawed is ${gap}, under the required ${meta.minGap} — the grader does not clearly rank them`);
  }
  return { ok: problems.length === 0, problems, gap };
}

/**
 * Render the report.
 *
 * @param {Array<Object>} rows - One per case.
 * @param {{endpoint: string, previous: Object|null, drift: Array<string>}} meta
 * @returns {string}
 */
function renderReport(rows, meta) {
  const lines = [];
  lines.push("# Grader Calibration");
  lines.push("");
  lines.push(`Run: ${new Date().toISOString()}`);
  lines.push(`Verifier: ${meta.endpoint}`);
  lines.push(`Passing score: ${PASSING_SCORE}`);
  if (meta.ranIds && meta.ranIds.length < rows.length) {
    lines.push(`Graded this run: ${meta.ranIds.join(", ")} (the other rows are carried from an earlier run).`);
  }
  lines.push("");
  lines.push(
    "**What this measures.** Every case is a short source text with a KNOWN defect in one " +
      "translation and a faithful rendering in the other. The production verifier grades both. " +
      "If it cannot tell them apart, the gates that use its number are decoration."
  );
  lines.push("");
  lines.push("| Case | Defect | Flawed | Band | Clean | Band | Gap | Verdict |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.defect} | ${r.flawed.score === null ? "n/a" : r.flawed.score} | ${r.flawed.band} | ` +
        `${r.clean.score === null ? "n/a" : r.clean.score} | ${r.clean.band} | ` +
        `${r.gap === null ? "n/a" : r.gap} | ${r.ok ? "OK" : "**FAIL**"} |`
    );
  }
  lines.push("");

  const scored = rows.filter((r) => r.flawed.score !== null && r.clean.score !== null);
  if (scored.length > 0) {
    const flawedMean = Math.round(scored.reduce((n, r) => n + r.flawed.score, 0) / scored.length);
    const cleanMean = Math.round(scored.reduce((n, r) => n + r.clean.score, 0) / scored.length);
    const gaps = scored.map((r) => r.gap);
    lines.push(`**Distribution.** Flawed mean **${flawedMean}** · clean mean **${cleanMean}** · ` +
      `median gap **${medianScore(gaps)}** (min ${Math.min(...gaps)}, max ${Math.max(...gaps)}).`);
    lines.push("");
    lines.push(
      `A grader whose flawed mean sits near the passing line is a grader that lets defects through: ` +
      `the number to watch between runs is the **gap**, not either mean.`
    );
    lines.push("");
  }

  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    lines.push(`## Problems (${failed.length})`);
    lines.push("");
    for (const r of failed) {
      lines.push(`- **${r.id}**`);
      for (const p of r.problems) lines.push(`  - ${p}`);
    }
    lines.push("");
  }

  if (meta.drift.length > 0) {
    lines.push(`## Drift since the previous run`);
    lines.push("");
    for (const d of meta.drift) lines.push(`- ${d}`);
    lines.push("");
    lines.push(`A grader that drifts softer shows up here. It is the same number the pipeline acts on.`);
    lines.push("");
  } else if (meta.previous) {
    lines.push(`No score changed since the previous run.`);
    lines.push("");
  } else {
    lines.push(`First recorded run — the next run compares against this one.`);
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  const caseArg =
    (process.argv.find((a) => a.startsWith("--case=")) || "").replace("--case=", "") ||
    (process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : null);

  const spec = JSON.parse(await fs.readFile(CASES_FILE, "utf8"));
  let cases = spec.cases;
  if (caseArg) {
    cases = cases.filter((c) => c.id === caseArg);
    if (cases.length === 0) throw new Error(`No calibration case named ${caseArg} (have: ${spec.cases.map((c) => c.id).join(", ")})`);
  }

  const harness = require("../harness");
  const { gradeChapter } = require("../verify-translate");
  const systemPrompt = await fs.readFile(path.join(__dirname, "..", "system-prompts", "verify-translate.md"), "utf8");
  const template = await fs.readFile(path.join(__dirname, "..", "user-prompts", "verify-translate.md"), "utf8");
  const endpoint = roleEndpoint("VERIFY");

  console.log(`[calibrate] grading ${cases.length} case(s) with ${describeEndpoint(endpoint)} at temperature ${judgeTemperature()}`);
  console.log(`[calibrate] passing score ${PASSING_SCORE} — a flawed text above it is a defect the pipeline would publish.`);

  const deps = { gradeChapter, systemPrompt, template, endpoint };
  const rows = [];
  for (const meta of cases) {
    const text = await readCase(meta.id);
    const flawed = await gradeOne(meta, { source: text.source, draft: text.flawed }, deps, "flawed");
    const clean = await gradeOne(meta, { source: text.source, draft: text.clean }, deps, "clean");
    const verdict = judgeCase(meta, { clean, flawed });
    rows.push({
      id: meta.id,
      title: meta.title,
      defect: meta.defect,
      flawed,
      clean,
      gap: verdict.gap,
      ok: verdict.ok,
      problems: verdict.problems,
    });
    console.log(
      `  ${meta.id}: flawed ${flawed.score === null ? "n/a" : flawed.score} (${flawed.band}) · ` +
        `clean ${clean.score === null ? "n/a" : clean.score} (${clean.band}) · gap ${verdict.gap === null ? "n/a" : verdict.gap} ` +
        `→ ${verdict.ok ? "OK" : "FAIL"}`
    );
    for (const p of verdict.problems) console.log(`      ! ${p}`);
  }

  // Drift against the previous run (the point of keeping the JSON).
  let previous = null;
  const drift = [];
  try {
    previous = JSON.parse(await fs.readFile(REPORT_JSON, "utf8"));
    for (const r of rows) {
      const before = (previous.rows || []).find((x) => x.id === r.id);
      if (!before) continue;
      for (const variant of ["flawed", "clean"]) {
        const oldScore = before[variant].score;
        const newScore = r[variant].score;
        if (oldScore === null || newScore === null) continue;
        const d = newScore - oldScore;
        if (Math.abs(d) >= 5) {
          drift.push(`${r.id} ${variant}: ${oldScore} → ${newScore} (${d > 0 ? "+" : ""}${d})`);
        }
      }
    }
  } catch {
    // No previous report: this run becomes the baseline.
  }

  // A `--case` run must not throw away the rest of the baseline: the cases that
  // were not graded this time keep their recorded scores (the drift comparison
  // above only ever compares the cases that actually ran).
  let allRows = rows;
  if (previous && Array.isArray(previous.rows) && cases.length < spec.cases.length) {
    const byId = new Map(previous.rows.map((r) => [r.id, { ...r, carried: true }]));
    for (const r of rows) byId.set(r.id, r);
    allRows = spec.cases.map((c) => byId.get(c.id)).filter(Boolean);
  }

  const md = renderReport(allRows, {
    endpoint: describeEndpoint(endpoint),
    previous,
    drift,
    ranIds: rows.map((r) => r.id),
  });
  await fs.writeFile(REPORT_MD, md, "utf8");
  await fs.writeFile(
    REPORT_JSON,
    JSON.stringify({ schema: 1, ranAt: new Date().toISOString(), endpoint: describeEndpoint(endpoint), passingScore: PASSING_SCORE, rows: allRows }, null, 2) + "\n",
    "utf8"
  );
  console.log(`[calibrate] report → ${REPORT_MD}`);

  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    throw new Error(
      `calibration: ${failed.length} of ${rows.length} case(s) failed — the grader did not rank a known defect below a faithful ` +
        `translation. See ${REPORT_MD}. (A grader that cannot see these cannot see them in the series either.)`
    );
  }
  console.log(`[calibrate] all ${rows.length} case(s) ranked the known defect below the faithful translation.`);
  void harness;
  void assert;
}

main().catch((err) => {
  console.error(`[calibrate] ${err.message}`);
  process.exitCode = 1;
});
