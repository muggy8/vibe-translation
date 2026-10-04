#!/usr/bin/env node
/**
 * test-pipeline-loop.js — run the WHOLE pipeline offline against the scripted
 * model server, and record every request that went over the wire.
 *
 * `test-fake-backend.js` proves the stub can drive one call. `test-translate-stage.js`
 * proves it can drive one task. This runs the ten tasks in the order `npx gulp`
 * runs them, on a real two-volume series laid out in a temp folder, with
 * `fake-workflow.js` answering behind the stub the way a real model answers:
 *
 *   discover → glossary → character-voice → style-guide → jump-in-wiki
 *           → consistency-audit → translate → translate-qa → polish → translation-report
 *
 * Nothing is mocked below the task code: the real manifest intake, the real
 * source bundles, the real agent loop and file tools, the real approve gate, the
 * real acceptance loops, the real QA loop, the real reports. The artifacts land
 * on disk and the pipeline's own gates judge them, so a green run means the
 * plumbing is right and a red run points at the stage that broke.
 *
 * THE OTHER HALF — THE WIRE LOG
 * -----------------------------
 * Every request is recorded exactly as it left the pipeline: the model id, the
 * sampling parameters, the tool schemas that were advertised, and the full text
 * of every message. `report/wire-log.md` is that log in readable form, and
 * `prompt-audit.js` reads it and reports the classes of mistake a real run would
 * pay for in hours: a tool the prompt promises but the code never registered, a
 * tool argument name that does not match the schema, a reference block that never
 * reached the prompt, a system prompt where the translator contract forbids one,
 * a polisher shown the source text, the stages running out of order, a prompt that
 * leaked a `{{PLACEHOLDER}}`, or a stage that made a call it should have skipped.
 *
 * Then the whole pipeline runs a SECOND time over the same series and must make
 * ZERO model calls — the idempotency machinery is part of what is being tested.
 *
 * Usage:
 *   node test/test-pipeline-loop.js                    full run + audit + second pass
 *   node test/test-pipeline-loop.js --stages=glossary  narrow it while debugging
 *   node test/test-pipeline-loop.js --no-second-pass
 *   node test/test-pipeline-loop.js --audit-selftest   plant known prompt defects
 *                                                    and prove the audit reports them
 *   node test/test-pipeline-loop.js --stage=glossary   (internal child mode)
 *
 * Output: /tmp/opencode/pipeline-loop/  (override with PIPELINE_LOOP_DIR)
 *   series/            the fixture series, with every generated artifact on disk
 *   report/wire-log.md every request, with the full prompt text
 *   report/wire-log.json  the same, machine-readable
 *   report/prompt-audit.md  the findings
 *   report/<stage>.log   each stage's own console output
 *
 * Plain `assert`, no framework, CommonJS — like the rest of the project.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { startFakeBackend } = require("./fake-backend");
const workflow = require("./fake-workflow");
const { auditPromptLog, renderAuditReport } = require("./prompt-audit");

const ROOT = path.resolve(__dirname, "..");
const LOOP_DIR = process.env.PIPELINE_LOOP_DIR || "/tmp/opencode/pipeline-loop";
const SERIES_DIR = path.join(LOOP_DIR, "series");
const REPORT_DIR = path.join(LOOP_DIR, "report");
const HOOKS_DIR = path.join(LOOP_DIR, "empty-hooks");
const CALIBRATION_FILE = path.join(LOOP_DIR, "token-calibration.json");

/** The ten gulp tasks, in the order the default run uses. */
const STAGES = [
  "discover",
  "glossary",
  "character-voice",
  "style-guide",
  "jump-in-wiki",
  "consistency-audit",
  "translate",
  "translate-qa",
  "polish",
  "translation-report",
];

/** The role prefixes the translation stage resolves through `roleEndpoint()`. */
const ROLE_PREFIXES = ["TRANSLATE", "VERIFY", "EDIT", "AUDIT"];

/**
 * Run one task in this process (child mode). Each task module reads
 * `SERIES_LOCATION` at module load, so the parent hands the whole environment to
 * a fresh process and this runs exactly the gulp task's own function.
 *
 * @param {string} name - One of STAGES.
 * @returns {Promise<void>}
 */
async function runStageChild(name) {
  const started = Date.now();
  try {
    switch (name) {
      case "discover":
        await require("../get-translation-target").discoverSeries();
        break;
      case "glossary":
        await require("../glossary").glossary();
        break;
      case "character-voice":
        await require("../character-voice").characterVoice();
        break;
      case "style-guide":
        await require("../style-guide").styleGuide();
        break;
      case "jump-in-wiki":
        await require("../jump-in-wiki").jumpInWiki();
        break;
      case "consistency-audit":
        await require("../consistency-audit").consistencyAudit();
        break;
      case "translate":
        await require("../translate").translate();
        break;
      case "translate-qa":
        await require("../translate-qa").translateQa();
        break;
      case "polish":
        await require("../polish").polish();
        break;
      case "translation-report": {
        const manifest = await require("../get-translation-target").getTranslationTarget({ dryRun: false });
        await require("../utils/translation-report").writeTranslationReport({
          seriesDir: process.env.SERIES_LOCATION,
          manifest,
          volumes: manifest.volumes.map((v) => v.folder),
          dryRun: false,
        });
        break;
      }
      default:
        throw new Error(`unknown stage "${name}"`);
    }
    console.log(`CHILD-OK ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error(`CHILD-FAIL ${name}: ${err && err.message}`);
    if (err && err.stack) console.error(String(err.stack).split("\n").slice(0, 8).join("\n"));
    process.exitCode = 1;
  }
}

/**
 * The environment every stage child runs with. Pinned explicitly rather than
 * inherited, so the run means the same thing on this machine as on the one that
 * has the real 17-volume series in its `.env` (dotenv never overrides a variable
 * that is already set, which is what makes pinning here work).
 *
 * @param {Record<string, string>} endpoint - The `AI_*` / `<ROLE>_*` values the
 *   stub published through `pointEnvAt`.
 * @returns {Record<string, string>}
 */
function childEnv(endpoint) {
  return {
    ...process.env,
    ...endpoint,

    SERIES_LOCATION: SERIES_DIR,

    // Small but real numbers: the fixture is tiny, so every size decision lands
    // on the whole-installment path, exactly as a real volume of this size would.
    AI_CONTEXT_WINDOW: "32768",
    AI_MAX_TOKENS: "8192",
    AI_TEMPERATURE: "0.7",
    AI_RETRY: "0",
    AI_CALL_DEADLINE_MS: "120000",

    // The one stage the stub genuinely cannot cover: `wiki_search` /
    // `wiki_extract` are not model calls, they are HTTP calls to Wikipedia made
    // by the harness tools. Everything else runs for real.
    RESEARCH_ENABLED: "false",

    // No hooks: this machine's hooks switch real containers in.
    AI_CLIENT_HOOKS_DIR: HOOKS_DIR,
    TOKEN_CALIBRATION_FILE: CALIBRATION_FILE,

    // The production defaults, spelled out so the run is reproducible.
    PASSING_SCORE: "70",
    ACCEPTANCE_WINDOW_SIZE: "2",
    QA_MAX_ITERATIONS: "3",
    TRANSLATE_QA_MAX_ROUNDS: "3",
    POLISH_QA_MAX_ROUNDS: "3",
    STAGE_CONCURRENCY: "1",
    DISCOVER_MAX_ATTEMPTS: "1",

    // Fail loudly: a scripted run that trips a guard has to say so, not absorb it.
    ON_VOLUME_ERROR: "abort",
    ON_MISSING_PREVIOUS: "abort",
    ON_QA_LIMIT: "fail",
    ON_TASK_ERROR: "abort",
  };
}

/**
 * A short summary of what the scripted brain answered, so the wire log shows the
 * exchange and not only the request.
 *
 * @param {import("./fake-backend").FakeReply} answer
 * @returns {Object}
 */
function summarizeAnswer(answer) {
  const text = answer.text || "";
  return {
    chars: text.length,
    paragraphs: text.trim() ? text.trim().split(/\n\s*\n/).length : 0,
    head: text.slice(0, 120),
    tail: text.length > 120 ? text.slice(-120) : "",
    reasoningChars: (answer.reasoning || "").length,
    finishReason: answer.finishReason || (answer.status ? null : "stop"),
    status: answer.status || null,
    error: answer.error || null,
    toolCalls: (answer.toolCalls || []).map((call) => ({
      name: call.name,
      arguments: typeof call.arguments === "string" ? safeParse(call.arguments) : call.arguments || {},
    })),
  };
}

/**
 * @param {string} text
 * @returns {Object|string}
 */
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Turn the recorded wire traffic into the records the audit reads: one entry per
 * request, with the tool schemas flattened to names + argument names and the
 * prompt measured per message.
 *
 * @param {import("./fake-backend").FakeRequest[]} requests
 * @param {Object[]} answers
 * @param {Array<{name: string, from: number, to: number}>} spans - Which stage
 *   each request index belongs to.
 * @returns {Object[]}
 */
function buildWireLog(requests, answers, spans) {
  const stageOf = (index) => (spans.find((s) => index >= s.from && index < s.to) || { name: "?" }).name;
  return requests.map((req, index) => {
    const messages = (req.messages || []).map((message) => {
      const content = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
          : "";
      return {
        role: message.role,
        chars: content.length,
        text: content,
        toolCalls: (message.tool_calls || []).map((call) => ({
          name: call?.function?.name,
          arguments: safeParse(call?.function?.arguments || "{}"),
        })),
      };
    });
    return {
      index,
      stage: stageOf(index),
      model: req.model,
      stream: req.stream,
      sampling: {
        temperature: req.temperature ?? null,
        topP: req.body?.top_p ?? null,
        topK: req.body?.top_k ?? null,
        repetitionPenalty: req.body?.repetition_penalty ?? null,
        maxTokens: req.maxTokens ?? null,
        reasoningEffort: req.reasoningEffort,
        chatTemplateKwargs: req.chatTemplateKwargs,
      },
      tools: (req.tools || []).map((tool) => ({
        name: tool?.function?.name ?? tool?.name,
        description: tool?.function?.description ?? "",
        parameters: Object.keys(tool?.function?.parameters?.properties || {}),
      })),
      messages,
      systemText: messages.filter((m) => m.role === "system").map((m) => m.text).join("\n"),
      userText: messages.filter((m) => m.role !== "system").map((m) => m.text).join("\n"),
      promptChars: messages.reduce((sum, m) => sum + m.chars, 0),
      answer: answers[index] || null,
    };
  });
}

/**
 * The readable form of the wire log: every request, in order, with the full text
 * the model was shown. This is the file a human opens when a stage produces
 * something odd and the question is "what did it actually get told?".
 *
 * @param {Object[]} log
 * @returns {string}
 */
function renderWireLog(log) {
  const lines = [
    "# Wire log — every request the pipeline sent to the scripted model server",
    "",
    "Each entry is what actually left the pipeline: the model id it asked for, the",
    "sampling parameters on the wire, the tool schemas it advertised, the full text",
    "of every message, and what the scripted model answered back.",
    "",
    "## Index",
    "",
    "| # | stage | model | tools | prompt chars | answered |",
    "|---|---|---|---|---|---|",
  ];
  for (const entry of log) {
    const answer = entry.answer
      ? entry.answer.status
        ? `HTTP ${entry.answer.status}`
        : `${entry.answer.chars} chars${entry.answer.toolCalls.length ? ` + ${entry.answer.toolCalls.length} tool call(s)` : ""}`
      : "—";
    lines.push(
      `| ${entry.index} | ${entry.stage} | ${entry.model} | ${entry.tools.length === 0 ? "—" : entry.tools.length} | ${entry.promptChars} | ${answer} |`
    );
  }
  for (const entry of log) {
    lines.push("");
    lines.push(`---`);
    lines.push("");
    lines.push(`## #${entry.index} — ${entry.stage} — model \`${entry.model}\``);
    lines.push("");
    lines.push(
      `- stream: ${entry.stream}, prompt: ${entry.promptChars} chars, ` +
        `temperature: ${entry.sampling.temperature}, max_tokens: ${entry.sampling.maxTokens}, ` +
        `reasoning_effort: ${entry.sampling.reasoningEffort === null ? "—" : entry.sampling.reasoningEffort}` +
        (entry.sampling.chatTemplateKwargs ? `, chat_template_kwargs: ${JSON.stringify(entry.sampling.chatTemplateKwargs)}` : "")
    );
    lines.push(
      `- tools advertised: ${entry.tools.length === 0 ? "none" : entry.tools.map((t) => `${t.name}(${t.parameters.join(", ")})`).join(", ")}`
    );
    if (entry.answer) {
      const answer = entry.answer;
      const answered = answer.status
        ? `HTTP ${answer.status}: ${answer.error}`
        : `${answer.chars} chars${answer.reasoningChars ? ` + ${answer.reasoningChars} reasoning` : ""}`;
      lines.push(
        `- answered: ${answered}, finish_reason: ${answer.finishReason === null ? "—" : answer.finishReason}` +
          (answer.toolCalls.length ? `, tool calls: ${answer.toolCalls.map((c) => c.name).join(", ")}` : "")
      );
      for (const call of answer.toolCalls) {
        lines.push(`  - \`${call.name}\` ← ${JSON.stringify(call.arguments).slice(0, 400)}`);
      }
    }
    for (const message of entry.messages) {
      lines.push("");
      lines.push(`### ${message.role}${message.toolCalls.length ? ` (tool calls: ${message.toolCalls.map((c) => c.name).join(", ")})` : ""} — ${message.chars} chars`);
      lines.push("");
      lines.push("```");
      lines.push(message.text);
      lines.push("```");
    }
  }
  return lines.join("\n");
}

/**
 * The lines from a stage's own output that are worth printing during the run.
 *
 * @param {string} output
 * @returns {string[]}
 */
function digestOf(output) {
  const wanted = /CHILD-OK|CHILD-FAIL|WARNING|FAIL|PASS|skip|Volume|round|accepted|score|refus|error|Error/i;
  const lines = String(output || "").split("\n").map((l) => l.trim()).filter((l) => l && wanted.test(l));
  return lines.length > 24 ? lines.slice(0, 12).concat([`… ${lines.length - 24} more line(s) in the stage log …`], lines.slice(-12)) : lines;
}

/**
 * Run one stage in a child process WITHOUT blocking this process.
 *
 * That is not a detail: the scripted model server lives in THIS process, so a
 * synchronous spawn parks the event loop, the server stops answering, and every
 * stage hangs until its idle deadline fires with zero requests recorded. The
 * child has to be awaited asynchronously.
 *
 * @param {string} name - One of STAGES.
 * @param {Record<string, string>} env
 * @param {number} timeoutMs
 * @returns {Promise<{code: number, output: string, killed: boolean}>}
 */
function runStageAsync(name, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, `--stage=${name}`], { cwd: ROOT, env });
    let output = "";
    let killed = false;
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? -1 : code, output, killed });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -2, output: `${output}\nspawn error: ${err.message}`, killed: false });
    });
  });
}

/**
 * Run the whole pipeline once, in a fresh child process per task, and record which
 * request index range each stage owns.
 *
 * @param {Object} opts
 * @param {Record<string, string>} opts.endpoint - The stub's `AI_*` / `<ROLE>_*` values.
 * @param {import("./fake-backend").FakeBackend} opts.backend
 * @param {string} opts.label - "pass-1" / "pass-2", used for the log file names.
 * @returns {Promise<{stages: Object[], spans: Array<{name: string, from: number, to: number, calls: number}>}>}
 */
async function runPipeline({ endpoint, backend, label }) {
  const env = childEnv(endpoint);
  const stages = [];
  const spans = [];
  for (const name of selectedStages()) {
    const from = backend.requests.length;
    const started = Date.now();
    const result = await runStageAsync(name, env, 15 * 60 * 1000);
    const ok = result.code === 0;
    fs.writeFileSync(path.join(REPORT_DIR, `${label}-${name}.log`), result.output, "utf8");
    const calls = backend.requests.length - from;
    stages.push({ name, ok, code: result.code, ms: Date.now() - started, calls, output: result.output });
    spans.push({ name, from, to: backend.requests.length, calls });

    console.log(
      `\n[${label}] ${name} — ${ok ? "ok" : `FAILED (exit ${result.code}${result.killed ? ", killed on timeout" : ""})`} — ` +
        `${calls} model call(s), ${((Date.now() - started) / 1000).toFixed(1)}s`
    );
    for (const line of digestOf(result.output)) console.log(`    ${line}`);
    if (!ok) break; // Every later task depends on this one's artifacts.
  }
  return { stages, spans };
}

/**
 * Prove the scripted fixture satisfies the pipeline's own no-AI rules before
 * spending a run on it.
 *
 * @returns {boolean} - false when a check failed.
 */
function reportSelfCheck() {
  const checks = workflow.selfCheck();
  const failed = checks.filter((c) => !c.ok);
  console.log(`fixture self-check: ${checks.length - failed.length}/${checks.length} pass`);
  for (const check of failed) console.log(`  FAIL volume ${check.volume} — ${check.check}: ${check.detail}`);
  return failed.length === 0;
}

/**
 * List what the run actually produced on disk, so the report shows the artifacts
 * the pipeline wrote and not only the calls it made.
 */
function writeSeriesTree() {
  const lines = [`# Files in ${SERIES_DIR}`, ""];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${"  ".repeat(depth)}${entry.name}/`);
        walk(full, depth + 1);
      } else {
        const size = fs.statSync(full).size;
        lines.push(`${"  ".repeat(depth)}${entry.name}  (${size} bytes)`);
      }
    }
  };
  walk(SERIES_DIR, 0);
  fs.writeFileSync(path.join(REPORT_DIR, "series-tree.txt"), lines.join("\n"), "utf8");
}

/**
 * The stages this run should execute. `--stages=glossary,translate` narrows the
 * loop while debugging one stage; the default is the whole pipeline.
 *
 * @returns {string[]}
 */
function selectedStages() {
  const arg = process.argv.find((a) => a.startsWith("--stages="));
  if (!arg) return STAGES;
  const wanted = arg.slice("--stages=".length).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((name) => !STAGES.includes(name));
  if (unknown.length > 0) throw new Error(`unknown stage(s): ${unknown.join(", ")}. Known: ${STAGES.join(", ")}`);
  return STAGES.filter((name) => wanted.includes(name));
}

/**
 * Prove the audit can fail. A check that never reports anything is not a check,
 * so this builds a small synthetic wire log with one KNOWN defect per rule and
 * asserts each one is reported. Run it with `--audit-selftest`.
 *
 * @returns {boolean} - false when a planted defect went unnoticed.
 */
function runAuditSelfTest() {
  const { auditPromptLog } = require("./prompt-audit");
  const vol01 = workflow.VOLUMES[0];
  const vol02 = workflow.VOLUMES[1];
  const sys = (file) => fs.readFileSync(path.join(ROOT, "system-prompts", file), "utf8");

  // The artifacts the audit reads off disk, laid out where it expects them.
  const selfDir = path.join(LOOP_DIR, "selftest-series");
  const volumeDir = path.join(selfDir, vol01.folder);
  fs.mkdirSync(volumeDir, { recursive: true });
  fs.writeFileSync(path.join(volumeDir, "glossary.md"), workflow.glossaryMarkdown(vol01), "utf8");
  fs.writeFileSync(
    path.join(volumeDir, "glossary-validation.md"),
    "# Glossary Validation\n\n## Findings\n\n1. **[LOW] A note is thinner than the rest.**\n\n**Recommendation:** Pass\n",
    "utf8"
  );

  /**
   * Build one wire-log entry with the defaults a real request has.
   *
   * @param {number} index
   * @param {Object} opts
   * @returns {Object}
   */
  const entry = (index, opts) => {
    const messages = [];
    if (opts.system) messages.push({ role: "system", chars: opts.system.length, text: opts.system, toolCalls: [] });
    if (opts.user) messages.push({ role: "user", chars: opts.user.length, text: opts.user, toolCalls: [] });
    const text = opts.answer?.text || "";
    return {
      index,
      stage: opts.stage,
      model: opts.model || "stub",
      stream: true,
      sampling: {
        temperature: opts.temperature ?? 0.7,
        topP: opts.topP ?? 1,
        topK: opts.topK ?? -1,
        repetitionPenalty: opts.repetitionPenalty ?? 1,
        maxTokens: opts.maxTokens ?? 8192,
        reasoningEffort: opts.reasoningEffort ?? null,
        chatTemplateKwargs: null,
      },
      tools: opts.tools || [],
      messages,
      systemText: opts.system || "",
      userText: opts.user || "",
      promptChars: messages.reduce((n, m) => n + m.chars, 0),
      answer: {
        chars: text.length,
        paragraphs: text.trim() ? text.trim().split(/\n\s*\n/).length : 0,
        head: text.slice(0, 120),
        tail: "",
        reasoningChars: 0,
        finishReason: opts.finishReason || (opts.toolCalls ? "tool_calls" : "stop"),
        status: opts.status || null,
        error: null,
        toolCalls: opts.toolCalls || [],
      },
    };
  };

  const fsTools = [
    { name: "readFile", description: "", parameters: ["filePath"] },
    { name: "writeFile", description: "", parameters: ["filePath", "content"] },
  ];
  const authorSystem = sys("glossary.md");
  const authorUser = (volume, extra = "") =>
    `# Glossary Amendment\n\n**Volume being processed:** ${volume.installment}\n\n${extra}${workflow.sourceTextOf(volume)}`;
  const translateUser = (volume, tail = "") =>
    `*[Source Text]*\n${workflow.sourceTextOf(volume)}\n\n*[Translation Tasks]*\n` +
    `Translate the [Source Text] into ${workflow.SERIES.targetLanguage}. ONLY output the translated result.\n${tail}`;

  /** @type {Object[]} */
  const log = [];
  let i = 0;

  // 1. A tool argument the schema does not have (`text` instead of `content`).
  log.push(entry(i++, { stage: "glossary", system: authorSystem, user: authorUser(vol01), tools: fsTools, toolCalls: [{ name: "writeFile", arguments: { filePath: "glossary.md", text: "…" } }] }));
  // 2. A tool the model reached for that was never advertised.
  log.push(entry(i++, { stage: "glossary", system: authorSystem, user: authorUser(vol01), tools: fsTools, toolCalls: [{ name: "writeGlossary", arguments: { filePath: "glossary.md" } }] }));
  // 3. A tool-less grader handed tool schemas.
  log.push(entry(i++, { stage: "glossary", system: sys("glossary-acceptance.md"), user: `Volume being processed: 01\n\n${workflow.glossaryMarkdown(vol01)}\n\n**Recommendation:** Pass`, tools: fsTools, answer: { text: '{"score":80,"band":"Pass","note":"ok"}' } }));
  // 4. The translator given a system prompt and the wrong sampling.
  log.push(
    entry(i++, {
      stage: "translate",
      model: "stub-translate",
      system: "You are a translator.",
      user: translateUser(vol01),
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      reasoningEffort: "low",
      answer: { text: workflow.draftTextOf(vol01) },
    })
  );
  // 5. A translation reply that does not match its source paragraph-for-paragraph.
  log.push(
    entry(i++, {
      stage: "translate",
      model: "stub-translate",
      user: translateUser(vol01),
      reasoningEffort: "no_think",
      answer: { text: workflow.draftTextOf(vol01).split("\n\n").slice(0, 3).join("\n\n") },
    })
  );
  // 6. Volume 02 translated with no tail of volume 01, and its author turn never
  //    told where volume 01's glossary lives.
  log.push(entry(i++, { stage: "glossary", system: authorSystem, user: authorUser(vol02), tools: fsTools, toolCalls: [{ name: "writeFile", arguments: { filePath: "glossary.md", content: "…" } }] }));
  log.push(
    entry(i++, {
      stage: "translate",
      model: "stub-translate",
      user: translateUser(vol02),
      reasoningEffort: "no_think",
      answer: { text: workflow.draftTextOf(vol02) },
    })
  );
  // 7. The retranslate batch running before any verification happened.
  log.push(
    entry(i++, {
      stage: "retranslate",
      model: "stub-translate",
      user: `A previous translation of this text had the following problems and MUST fix all of them.\n\n${translateUser(vol01)}`,
      reasoningEffort: "no_think",
      answer: { text: workflow.fixedTextOf(vol01) },
    })
  );
  // 8. A placeholder that reached the model as literal text (and a verifier missing
  //    the story-background block it audits against).
  log.push(
    entry(i++, {
      stage: "verify-translate",
      model: "stub-verify",
      system: sys("verify-translate.md"),
      user:
        `*[Source Text]*\n${workflow.sourceTextOf(vol01)}\n\n*[Translation To Audit]*\n${workflow.draftTextOf(vol01)}\n\n` +
        `*[Canonical Glossary (source → target renderings)]*\n{{GLOSSARY}}\n\n*[House Style Rules]*\nrules\n\nSCORE: 90/100`,
      temperature: 0.2,
      answer: { text: "SCORE: 90/100\n\n## Findings\n(no findings)" },
    })
  );
  // 9. An answer cut off at the output cap.
  log.push(
    entry(i++, {
      stage: "polish",
      model: "stub-edit",
      system: sys("polish.md"),
      user: `*[Current Translation]*\n${workflow.draftTextOf(vol01)}\n\n*[Canonical Glossary (source → target renderings)]*\nrenderings\n`,
      finishReason: "length",
      answer: { text: workflow.polishedTextOf(vol01).split("\n\n")[0] },
    })
  );
  // 10. The polisher shown the source text it is kept away from.
  log.push(
    entry(i++, {
      stage: "polish",
      model: "stub-edit",
      system: sys("polish.md"),
      user: `*[Current Translation]*\n${workflow.draftTextOf(vol01)}\n\n*[Source Text]*\n${workflow.sourceTextOf(vol01)}`,
      answer: { text: workflow.polishedTextOf(vol01) },
    })
  );
  // 11. A request that matches no stage prompt at all.
  log.push(entry(i++, { stage: "translate", model: "stub-translate", user: "Please summarize this series for me.", answer: { text: "A story." } }));

  const audit = auditPromptLog(log, { workflow, seriesDir: selfDir });
  const reported = new Set(audit.findings.map((f) => f.rule));
  const expected = [
    "tool-argument-names",
    "tool-not-advertised",
    "call-shape",
    "translator-contract",
    "translation-shape",
    "cumulative-reference-path",
    "cross-volume-continuity",
    "placeholder-leak",
    "stage-ordering",
    "answer-shape",
    "polish-sees-source",
    "unscripted-call",
  ];
  console.log(`audit self-test: ${log.length} synthetic requests, ${audit.findings.length} finding(s)`);
  let missed = 0;
  for (const rule of expected) {
    if (!reported.has(rule)) {
      missed += 1;
      console.log(`  FAIL — the audit did NOT report the planted "${rule}" defect`);
    }
  }
  for (const finding of audit.findings) console.log(`  reported [${finding.severity}] ${finding.rule}: ${finding.detail}`);
  return missed === 0;
}

async function main() {
  const stageArg = process.argv.find((arg) => arg.startsWith("--stage="));
  if (stageArg) return runStageChild(stageArg.slice("--stage=".length));

  if (process.argv.includes("--audit-selftest")) {
    console.log("pipeline loop — audit self-test");
    const ok = runAuditSelfTest();
    console.log(ok ? "OK: the audit reported every planted prompt defect." : "FAILED: the audit missed a planted defect.");
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const wantSecondPass = !process.argv.includes("--no-second-pass");

  fs.rmSync(LOOP_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  workflow.writeFixtureSources(SERIES_DIR);

  console.log(`pipeline loop — ${LOOP_DIR}`);
  console.log(`series: ${SERIES_DIR} (${workflow.VOLUMES.length} volumes, plain text)`);
  if (!reportSelfCheck()) {
    console.error("The scripted answers would fail the pipeline's own checks. Fix the fixture before running.");
    process.exitCode = 1;
    return;
  }

  /** @type {Object[]} */
  const answers = [];
  /** @type {string[]} */
  const unscripted = [];
  const backend = await startFakeBackend({
    model: ["stub", "stub-translate", "stub-verify", "stub-edit", "stub-audit"],
    reply: (req) => {
      const answer = workflow.answer(req, {
        seriesDir: SERIES_DIR,
        log: (line) => unscripted.push(line),
      });
      answers.push(summarizeAnswer(answer));
      return answer;
    },
  });
  backend.pointEnvAt({ prefixes: ROLE_PREFIXES });
  const endpoint = {
    AI_BASE_URL: backend.baseUrl,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
    ...ROLE_PREFIXES.reduce((acc, prefix) => {
      acc[`${prefix}_MODEL`] = process.env[`${prefix}_MODEL`];
      return acc;
    }, {}),
  };
  console.log(`stub endpoint: ${backend.baseUrl} — advertises ${backend.advertised.join(", ")}`);

  const first = await runPipeline({ endpoint, backend, label: "pass-1" });
  const firstCallCount = backend.requests.length;

  let second = null;
  if (wantSecondPass && first.stages.every((stage) => stage.ok)) {
    console.log(`\n[pass 2] re-running every task over the same series — the idempotency machinery is under test.`);
    second = await runPipeline({ endpoint, backend, label: "pass-2" });
  }

  const log = buildWireLog(backend.requests, answers, first.spans.concat(second ? second.spans : []));
  fs.writeFileSync(path.join(REPORT_DIR, "wire-log.json"), JSON.stringify(log, null, 2), "utf8");
  fs.writeFileSync(path.join(REPORT_DIR, "wire-log.md"), renderWireLog(log), "utf8");

  const audit = auditPromptLog(log, { workflow, seriesDir: SERIES_DIR, firstCallCount });
  fs.writeFileSync(path.join(REPORT_DIR, "prompt-audit.md"), renderAuditReport(audit), "utf8");

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("=== stage results ===");
  for (const stage of first.stages) {
    console.log(`  ${stage.ok ? "ok  " : "FAIL"} ${stage.name.padEnd(18)} ${String(stage.calls).padStart(3)} call(s)  ${((stage.ms / 1000).toFixed(1) + "s").padStart(8)}`);
  }
  if (second) {
    console.log("");
    console.log("=== second pass (idempotency) ===");
    for (const stage of second.stages) {
      console.log(`  ${stage.ok ? "ok  " : "FAIL"} ${stage.name.padEnd(18)} ${String(stage.calls).padStart(3)} call(s)`);
    }
  }

  console.log("");
  console.log(`total model calls: pass 1 = ${firstCallCount}${second ? `, pass 2 = ${backend.requests.length - firstCallCount}` : ""}`);
  if (unscripted.length > 0) {
    console.log(`unscripted requests (${unscripted.length}) — the brain had no answer for these:`);
    for (const line of unscripted.slice(0, 10)) console.log(`  ${line}`);
  }

  const problems = audit.findings.filter((f) => f.severity !== "info");
  console.log("");
  console.log(`prompt audit: ${audit.checks.length} checks, ${problems.length} finding(s)`);
  for (const finding of problems) {
    console.log(`  [${finding.severity}] ${finding.rule}: ${finding.detail}`);
    for (const line of (finding.items || []).slice(0, 6)) console.log(`      ${line}`);
  }
  for (const check of audit.checks) {
    console.log(`  ok  ${check.rule} — ${check.detail}`);
  }

  writeSeriesTree();

  console.log("");
  console.log(`report: ${path.join(REPORT_DIR, "wire-log.md")}`);
  console.log(`        ${path.join(REPORT_DIR, "prompt-audit.md")}`);
  console.log(`        ${path.join(REPORT_DIR, "series-tree.txt")}`);

  const failedStage = first.stages.find((stage) => !stage.ok);
  const secondPassMadeCalls = second ? backend.requests.length - firstCallCount : 0;
  if (failedStage) {
    console.log(`\nFAILED: stage ${failedStage.name} exited ${failedStage.code}. Full output in ${path.join(REPORT_DIR, `pass-1-${failedStage.name}.log`)}`);
    process.exitCode = 1;
  } else if (problems.length > 0) {
    console.log(`\nFAILED: the prompt audit reported ${problems.length} problem(s).`);
    process.exitCode = 1;
  } else if (second && (secondPassMadeCalls > 0 || second.stages.some((stage) => !stage.ok))) {
    console.log(`\nFAILED: the second pass was not a no-op (${secondPassMadeCalls} call(s)).`);
    process.exitCode = 1;
  } else {
    console.log("\nOK: the whole pipeline ran against the stub, the audit is clean, and the second pass made no calls.");
  }

  await backend.close();
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
