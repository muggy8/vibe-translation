/**
 * prompt-audit.js — read the recorded wire traffic and report what the pipeline
 * actually asked the model, as opposed to what it was supposed to ask.
 *
 * A translation run costs hours, and the expensive mistakes are not the model
 * answering badly — they are the pipeline asking badly: a tool the prompt promises
 * that the code never registered, a tool argument named `oldText` when the schema
 * says `oldString`, a translator running with no glossary in front of it, a
 * polisher quietly handed the source text it is contractually kept away from, a
 * verifier that never saw the story background, a `{{STYLE_RULES}}` placeholder
 * that reached the model as literal text, a stage that ran before the one it
 * depends on.
 *
 * Every rule here is a question about a request that can only be answered from the
 * wire, which is why `test-pipeline-loop.js` records requests verbatim.
 *
 * Plain `assert`-style checks, no framework, CommonJS.
 */

const fs = require("fs");
const path = require("path");

/** The token-calibration probe is a call of its own shape: one user message, no
 *  system prompt, `max_tokens: 1`, and the server's own usage count is the answer. */
const CALIBRATION_KIND = "calibration-probe";

/** Stages that are deterministic by design and therefore make no model call. */
const DETERMINISTIC_STAGES = new Set(["translation-report"]);

/** Kinds that must be tool-less calls (the one-shot contract). */
const ONE_SHOT_KINDS = new Set([
  "glossary-extract",
  "voice-extract",
  "style-extract",
  "acceptance",
  "verify",
  "volume-consistency",
  "translate",
  "retranslate",
  "polish",
  "polish-audit",
  CALIBRATION_KIND,
]);

/** Kinds that are agent turns and must therefore carry tool schemas. */
const AGENT_KINDS = new Set([
  "intake",
  "glossary-author",
  "glossary-validator",
  "glossary-feedback",
  "voice-author",
  "voice-validator",
  "voice-feedback",
  "style-author",
  "style-validator",
  "style-feedback",
  "wiki-author",
  "wiki-validator",
  "wiki-feedback",
  "audit-agent",
]);

/** The order the default pipeline runs its tasks in. */
const STAGE_ORDER = [
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

/** Which artifact family each acceptance grader is judging, from its system prompt. */
const ACCEPTANCE_FAMILIES = [
  ["translation glossary", { artifact: "glossary.md", report: "glossary-validation.md" }],
  ["character voice", { artifact: "character-voice.md", report: "character-voice-validation.md" }],
  ["style guide", { artifact: "style-guide.md", report: "style-guide-validation.md" }],
  ["jump-in wiki", { artifact: "shared-wiki.md", report: "jump-in-wiki-validation-{{NN}}.md" }],
];

/**
 * Rebuild the request shape `fake-workflow.classify` expects, so the audit and the
 * scripted brain agree on what each request was — one classification, no drift.
 *
 * @param {Object} entry - One wire-log entry.
 * @returns {{kind: string, volume: object|null, systemText: string, userText: string}}
 */
function identify(entry) {
  const req = {
    model: entry.model,
    maxTokens: entry.sampling.maxTokens,
    tools: entry.tools,
    messages: entry.messages.map((m) => ({ role: m.role, content: m.text, tool_calls: m.toolCalls })),
    allText: entry.messages.map((m) => m.text).join("\n"),
    userText: entry.messages
      .filter((m) => m.role !== "system")
      .map((m) => m.text)
      .join("\n"),
  };
  const { kind, volume, systemText } = require("./fake-workflow").classify(req);
  return {
    kind,
    volume: volume || require("./fake-workflow").volumeForText(req.userText),
    systemText,
    userText: req.userText,
  };
}

/**
 * Lines from a real artifact file that are distinctive enough to prove the file
 * was actually put in front of the model (not a heading, not a table separator).
 *
 * @param {string} filePath
 * @param {number} limit
 * @returns {string[]}
 */
function distinctiveLines(filePath, limit = 3) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 25 && !/^[|#-]+$/.test(line) && !line.startsWith("<!--"))
    .slice(0, limit);
}

/**
 * A window of text with every whitespace run removed — the comparison both
 * `planTargetedRepair` and this audit use, because a prompt re-wraps what it
 * quotes.
 *
 * @param {string} text
 * @returns {string}
 */
const flat = (text) => String(text || "").replace(/\s+/g, "");

/**
 * Run every audit rule over one wire log.
 *
 * @param {Object[]} log - The wire-log entries from `test-pipeline-loop.js`.
 * @param {{workflow: object, seriesDir: string, firstCallCount?: number}} opts
 * @returns {{checks: Object[], findings: Object[], stats: Object}}
 *   `checks` are the rules that passed (with the number behind them); `findings`
 *   are the problems, each with `severity` "error" or "warn".
 */
function auditPromptLog(log, { workflow, seriesDir, firstCallCount }) {
  const checks = [];
  const findings = [];
  const pass1 = firstCallCount ? log.slice(0, firstCallCount) : log;

  const identified = pass1.map((entry) => ({ entry, ...identify(entry) }));
  const byKind = (kind) => identified.filter((item) => item.kind === kind);

  const pass = (rule, detail, items = []) => checks.push({ rule, detail, items });
  const fail = (rule, detail, items = []) => findings.push({ rule, severity: "error", detail, items });
  const warn = (rule, detail, items = []) => findings.push({ rule, severity: "warn", detail, items });

  // ─── 1. Tools: advertised, used, and named the way the schema names them ────
  const toolGaps = [];
  const argGaps = [];
  for (const { entry, kind } of identified) {
    const advertised = new Map(entry.tools.map((tool) => [tool.name, tool.parameters || []]));
    for (const call of (entry.answer && entry.answer.toolCalls) || []) {
      if (!advertised.has(call.name)) {
        toolGaps.push(`#${entry.index} ${kind}: answered with \`${call.name}\`, which was never advertised`);
        continue;
      }
      const allowed = advertised.get(call.name);
      if (allowed.length === 0) continue;
      const given = Object.keys(call.arguments || {});
      const unknown = given.filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        argGaps.push(
          `#${entry.index} ${kind}: \`${call.name}\` called with ${unknown.map((k) => `\`${k}\``).join(", ")} — ` +
            `the schema offers ${allowed.map((k) => `\`${k}\``).join(", ")}`
        );
      }
    }
  }
  if (toolGaps.length) fail("tool-not-advertised", "a scripted answer reached for a tool the harness never registered.", toolGaps);
  else pass("tool-not-advertised", `${identified.reduce((n, i) => n + ((i.entry.answer && i.entry.answer.toolCalls) || []).length, 0)} tool calls, every one of them against a tool the request actually advertised.`);
  if (argGaps.length) fail("tool-argument-names", "a tool was called with an argument the advertised schema does not have (the `oldText` vs `oldString` class).", argGaps);
  else pass("tool-argument-names", "every tool argument matches the parameter name the advertised schema declares.");

  // ─── 2. One-shot calls carry no tools; agent turns carry tools ──────────────
  const shapeGaps = [];
  for (const { entry, kind } of identified) {
    if (kind === "unknown") continue;
    if (ONE_SHOT_KINDS.has(kind) && entry.tools.length > 0) {
      shapeGaps.push(`#${entry.index} ${kind}: a tool-less call was given ${entry.tools.length} tool schema(s)`);
    }
    if (AGENT_KINDS.has(kind) && entry.tools.length === 0) {
      shapeGaps.push(`#${entry.index} ${kind}: an agent turn was given NO tools — it cannot write anything`);
    }
  }
  if (shapeGaps.length) fail("call-shape", "a call's tool schemas do not match the kind of call it is.", shapeGaps);
  else pass("call-shape", `${identified.filter((i) => AGENT_KINDS.has(i.kind)).length} agent turn(s) all had tools; ${identified.filter((i) => ONE_SHOT_KINDS.has(i.kind)).length} one-shot call(s) all had none.`);

  // ─── 2b. A pipeline-stage agent must NOT be handed the memory tools ─────────
  // The context-management layer (utils/context.js) is deliberately limited to the
  // delivery roles — the diagnostics team and the dev team — because those turns are
  // uncapped and may read for a long time. A stage agent's whole job is the opposite:
  // it must keep everything it read IN context while it amends a cumulative document.
  // Handing it `manage_context` would let it set aside the very text it is required
  // to preserve, which is how 457 glossary terms once vanished (gotcha 64). The
  // harness only adds those tools for a managed handle, so a stage request carrying
  // them means the opt-in leaked into a stage.
  const CONTEXT_MEMORY_TOOLS = ["manage_context", "recall_memory"];
  const stageMemoryGaps = [];
  for (const { entry, kind } of identified) {
    if (!AGENT_KINDS.has(kind)) continue;
    const names = new Set(entry.tools.map((tool) => tool.name));
    for (const name of CONTEXT_MEMORY_TOOLS) {
      if (names.has(name)) {
        stageMemoryGaps.push(`#${entry.index} ${kind}: a pipeline-stage agent was offered \`${name}\` — context offloading is for the delivery layer only`);
      }
    }
  }
  if (stageMemoryGaps.length) fail("stage-context-offload", "a stage agent was given the tools that let it put its own reading out of context.", stageMemoryGaps);
  else pass("stage-context-offload", `${identified.filter((i) => AGENT_KINDS.has(i.kind)).length} stage agent turn(s) offered neither memory tool — their reading stays in context.`);

  // ─── 3. The translator's contract (Hy-MT2): one user message, official sampling
  const translator = identified.filter((i) => i.kind === "translate" || i.kind === "retranslate");
  const translatorGaps = [];
  for (const { entry, kind } of translator) {
    const system = entry.messages.filter((m) => m.role === "system");
    if (system.length > 0) translatorGaps.push(`#${entry.index} ${kind}: carries a system message — Hy-MT2's contract is a single user message`);
    if (entry.sampling.reasoningEffort !== "no_think") {
      translatorGaps.push(`#${entry.index} ${kind}: reasoning_effort is ${JSON.stringify(entry.sampling.reasoningEffort)}, expected "no_think"`);
    }
    const expected = { temperature: 0.7, topP: 1, topK: -1, repetitionPenalty: 1 };
    const actual = {
      temperature: entry.sampling.temperature,
      topP: entry.sampling.topP,
      topK: entry.sampling.topK,
      repetitionPenalty: entry.sampling.repetitionPenalty,
    };
    for (const [key, want] of Object.entries(expected)) {
      if (actual[key] !== want) translatorGaps.push(`#${entry.index} ${kind}: ${key} is ${JSON.stringify(actual[key])}, the official recipe says ${want}`);
    }
    if (!entry.userText.includes("Translate the [Source Text]")) {
      translatorGaps.push(`#${entry.index} ${kind}: the prompt does not end with the official task line`);
    }
    if (!entry.userText.includes("ONLY output the translated result")) {
      translatorGaps.push(`#${entry.index} ${kind}: the prompt does not carry the "ONLY output the translated result" guard`);
    }
  }
  if (translatorGaps.length) fail("translator-contract", "the translation call is not the shape the translator model is configured for.", translatorGaps);
  else pass("translator-contract", `${translator.length} translation call(s): no system message, no_think, temperature 0.7 / top_p 1.0 / top_k -1 / repetition_penalty 1.0, official task lines present.`);

  // ─── 3b. A call that GRADES must not sample like a call that WRITES ─────────
  // Reasoning tokens are billed out of the same reply budget as the answer, so a
  // grader that thinks too hard does not produce a worse score — it produces no
  // score (gotcha 59: one call spent 131,072 reasoning tokens and answered with
  // 0 characters). The pipeline's rule is that every tool-less call whose whole
  // job is to produce a number runs at JUDGE_TEMPERATURE + STAGE_THINKING_LEVEL;
  // only the authoring AGENT turns follow AI_THINKING_LEVEL (default xhigh),
  // because an author writing a 150 KB artifact is the call that needs the thinking.
  const JUDGING_KINDS = new Set(["acceptance", "verify", "polish-audit", "volume-consistency"]);
  const AUTHORING_LEVELS = new Set(["xhigh", "high"]);
  const dialectGaps = [];
  let judgingCalls = 0;
  for (const { entry, kind } of identified) {
    if (!JUDGING_KINDS.has(kind)) continue;
    judgingCalls += 1;
    if (AUTHORING_LEVELS.has(entry.sampling.reasoningEffort)) {
      dialectGaps.push(
        `#${entry.index} ${kind}: reasoning_effort ${JSON.stringify(entry.sampling.reasoningEffort)} is the AUTHORING level — ` +
          `this grader can spend the whole reply budget thinking and answer with nothing (gotcha 59)`
      );
    }
    const temperature = entry.sampling.temperature;
    if (typeof temperature === "number" && temperature > 0.2) {
      dialectGaps.push(`#${entry.index} ${kind}: temperature ${temperature} — a grading call runs at JUDGE_TEMPERATURE (0.2 or lower)`);
    }
  }
  if (dialectGaps.length) fail("judging-dialect", "a call that grades text is sampling like a call that writes it.", dialectGaps);
  else
    pass(
      "judging-dialect",
      `${judgingCalls} grading call(s) all run at the judging temperature and the calmer thinking level; the authoring agent turns keep ${"AI_THINKING_LEVEL"}.`
    );

  // ─── 4. The polisher must NOT see the source text ──────────────────────────
  const polishCalls = byKind("polish");
  const leaked = [];
  for (const { entry } of polishCalls) {
    const prompt = flat(entry.userText);
    for (const volume of workflow.VOLUMES) {
      const source = flat(workflow.sourceTextOf(volume));
      const window = source.slice(0, 60);
      if (window && prompt.includes(window)) leaked.push(`#${entry.index}: the polish prompt contains volume ${volume.installment}'s source text`);
    }
  }
  if (leaked.length) fail("polish-sees-source", "the polisher was shown the source text — the contract that keeps it from re-translating verified text (gotcha 24).", leaked);
  else pass("polish-sees-source", `${polishCalls.length} polish call(s), none of them given a single line of the source text.`);

  // ─── 5. The verifier must see source + draft + glossary + style + background ─
  const verifyGaps = [];
  const verifySeen = [];
  for (const { entry, volume } of byKind("verify")) {
    const prompt = entry.userText;
    for (const marker of ["*[Source Text]*", "*[Translation To Audit]*", "*[Canonical Glossary", "*[House Style Rules]", "*[Story Background"]) {
      if (!prompt.includes(marker)) verifyGaps.push(`#${entry.index}: the verify prompt has no ${marker} block`);
    }
    if (!volume) {
      verifyGaps.push(`#${entry.index}: the verify prompt does not contain the volume's source text at all`);
      continue;
    }
    const volumeDir = path.join(seriesDir, volume.folder);
    const draft = workflow.draftTextOf(volume);
    if (!flat(prompt).includes(flat(draft).slice(0, 80))) {
      verifyGaps.push(`#${entry.index}: the verify prompt does not contain the draft it is grading (volume ${volume.installment})`);
    }
    const glossaryLines = distinctiveLines(path.join(volumeDir, "glossary.md"), 2);
    if (!glossaryLines.some((line) => prompt.includes(line))) {
      verifyGaps.push(`#${entry.index}: no line of ${volume.folder}/glossary.md reached the verifier`);
    }
    const backgroundLines = distinctiveLines(path.join(volumeDir, "shared-wiki.md"), 3);
    if (!backgroundLines.some((line) => prompt.includes(line))) {
      verifyGaps.push(`#${entry.index}: no line of ${volume.folder}/shared-wiki.md reached the verifier (story background missing)`);
    }
    verifySeen.push(`#${entry.index} volume ${volume.installment}: ${entry.promptChars} chars, ${glossaryLines.length} glossary line(s) and ${backgroundLines.length} background line(s) confirmed present`);
  }
  if (verifyGaps.length) fail("verify-context", "the verifier was missing something it audits against.", verifyGaps);
  else pass("verify-context", `${byKind("verify").length} verification call(s) all carried the source, the draft, the glossary, the style rules and the story background.`, verifySeen);

  // ─── 6. The acceptance grader must see the artifact AND the validation report ─
  const acceptanceGaps = [];
  let acceptanceCount = 0;
  for (const { entry, kind } of byKind("acceptance")) {
    acceptanceCount += 1;
    const family = ACCEPTANCE_FAMILIES.find(([needle]) => entry.messages.some((m) => m.role === "system" && m.text.includes(needle)));
    const volume = identified.find((i) => i.entry === entry)?.volume;
    if (!family) {
      acceptanceGaps.push(`#${entry.index}: could not tell which artifact this grader is judging from its system prompt`);
      continue;
    }
    if (!volume) {
      acceptanceGaps.push(`#${entry.index}: the acceptance prompt names no volume`);
      continue;
    }
    const volumeDir = path.join(seriesDir, volume.folder);
    const artifact = path.join(volumeDir, family[1].artifact);
    const report = path.join(volumeDir, family[1].report.replace("{{NN}}", volume.installment));
    const lines = distinctiveLines(artifact, 2);
    if (!lines.some((line) => entry.userText.includes(line))) {
      acceptanceGaps.push(`#${entry.index} volume ${volume.installment}: the grader was never shown ${family[1].artifact}`);
    }
    if (!fs.existsSync(report)) {
      acceptanceGaps.push(`#${entry.index} volume ${volume.installment}: ${family[1].report} does not exist — the grader graded with no validation report`);
    } else if (!entry.userText.includes("**Recommendation:**")) {
      acceptanceGaps.push(`#${entry.index} volume ${volume.installment}: the validation report's recommendation line is not in the grader's prompt`);
    }
  }
  if (acceptanceGaps.length) fail("acceptance-context", "an acceptance grader scored without the material it is supposed to score.", acceptanceGaps);
  else pass("acceptance-context", `${acceptanceCount} acceptance grade(s), each shown the artifact it judges and the validator's report.`);

  // ─── 7. No placeholder reached the model as literal text ────────────────────
  const leaks = [];
  for (const { entry, kind } of identified) {
    for (const message of entry.messages) {
      const found = message.text.match(/\{\{[A-Z_]+\}\}/g);
      if (found) leaks.push(`#${entry.index} ${kind}: ${message.role} message contains ${found.join(", ")}`);
    }
  }
  if (leaks.length) fail("placeholder-leak", "a prompt template was sent to the model unfilled.", leaks);
  else pass("placeholder-leak", "no `{{PLACEHOLDER}}` survived into any request (transformUserPrompt is strict — this proves it ran).");

  // ─── 8. The translator must be shown the terminology law and the background ─
  const translateGaps = [];
  const translateSeen = [];
  for (const { entry, kind } of translator) {
    const volume = workflow.volumeForText(entry.userText);
    if (!volume) {
      translateGaps.push(`#${entry.index} ${kind}: the prompt does not contain the volume's own source text`);
      continue;
    }
    const volumeDir = path.join(seriesDir, volume.folder);
    for (const term of workflow.termsForVolume(volume.installment)) {
      const usedInSource = workflow.sourceTextOf(volume).includes(term.term);
      if (!usedInSource) continue;
      if (!entry.userText.includes(term.rendering)) {
        translateGaps.push(`#${entry.index} ${kind} volume ${volume.installment}: "${term.term}" is in the source but its canonical rendering "${term.rendering}" was not given to the translator`);
      }
    }
    const backgroundLines = distinctiveLines(path.join(volumeDir, "shared-wiki.md"), 3);
    if (backgroundLines.length > 0 && !backgroundLines.some((line) => entry.userText.includes(line))) {
      translateGaps.push(`#${entry.index} ${kind} volume ${volume.installment}: no story-background line reached the translator`);
    }
    const styleLines = distinctiveLines(path.join(volumeDir, "style-guide.md"), 2);
    if (styleLines.length > 0 && !styleLines.some((line) => entry.userText.includes(line))) {
      translateGaps.push(`#${entry.index} ${kind} volume ${volume.installment}: no house-style line reached the translator`);
    }
    translateSeen.push(`#${entry.index} ${kind} volume ${volume.installment}: ${entry.promptChars} chars, ${workflow.termsForVolume(volume.installment).length} glossary term(s) in law`);
  }
  if (translateGaps.length) fail("translator-context", "the translator was missing reference material the pipeline is supposed to inject.", translateGaps);
  else pass("translator-context", `${translator.length} translation call(s) all carried the glossary renderings for the terms their source uses, the story background and the house style rules.`);

  // ─── 9. Cross-volume continuity: volume 2's first chapter sees volume 1's tail
  const later = workflow.VOLUMES.slice(1);
  const continuityGaps = [];
  for (const volume of later) {
    const previous = workflow.VOLUMES[workflow.VOLUMES.indexOf(volume) - 1];
    const tail = flat(workflow.draftTextOf(previous)).slice(-160, -120);
    if (!tail) continue;
    const call = translator.find(
      (item) => item.kind === "translate" && workflow.volumeForText(item.entry.userText) === volume
    );
    if (!call) {
      continuityGaps.push(`volume ${volume.installment} has no translate call to inspect`);
      continue;
    }
    if (!flat(call.entry.userText).includes(tail)) {
      continuityGaps.push(`volume ${volume.installment}'s translate prompt does not contain the tail of volume ${previous.installment}'s published text`);
    }
  }
  if (continuityGaps.length) fail("cross-volume-continuity", "a volume was translated without the ending of the volume before it.", continuityGaps);
  else pass("cross-volume-continuity", `every volume after the first was translated with the previous volume's published tail in its prompt.`);

  // ─── 10. Ordering: nothing ran before the thing it depends on ───────────────
  const orderGaps = [];
  const firstIndexOf = (predicate) => {
    const hit = identified.find((item) => predicate(item));
    return hit ? hit.entry.index : -1;
  };
  const firstStageIndex = new Map();
  for (const item of identified) {
    if (!firstStageIndex.has(item.entry.stage)) firstStageIndex.set(item.entry.stage, item.entry.index);
  }
  const seenStages = STAGE_ORDER.filter((name) => firstStageIndex.has(name));
  for (let i = 1; i < seenStages.length; i++) {
    if (firstStageIndex.get(seenStages[i]) < firstStageIndex.get(seenStages[i - 1])) {
      orderGaps.push(`${seenStages[i]} made its first call before ${seenStages[i - 1]}`);
    }
  }
  const pairs = [
    ["glossary-extract", "glossary-author", "glossary extraction before the glossary amend"],
    ["glossary-author", "glossary-validator", "the glossary author before the glossary validator"],
    ["glossary-validator", "acceptance", "the validator before the acceptance grade"],
    ["voice-extract", "voice-author", "voice extraction before the voice compile"],
    ["style-extract", "style-author", "style extraction before the style compile"],
    ["audit-agent", "translate", "the consistency audit before the first translation"],
    ["verify", "retranslate", "verification before retranslation"],
    ["retranslate", "polish", "retranslation before the polish pass"],
    ["polish", "polish-audit", "the polish pass before its drift audit"],
  ];
  for (const [before, after, label] of pairs) {
    const a = firstIndexOf((item) => item.kind === before);
    const b = firstIndexOf((item) => item.kind === after);
    if (a === -1 || b === -1) continue; // That pair did not run in this scenario.
    if (b < a) orderGaps.push(`${label}: ${after} (#${b}) ran before ${before} (#${a})`);
  }
  if (orderGaps.length) fail("stage-ordering", "the calls did not happen in the order the pipeline is built in.", orderGaps);
  else pass("stage-ordering", `${seenStages.join(" → ")} — every stage's first call came after the stage it depends on, and within each volume: extract → author → validator → acceptance.`);

  // ─── 11. Nothing answered with an error, a cut-off, or nothing at all ───────
  const badAnswers = [];
  for (const { entry, kind } of identified) {
    const answer = entry.answer;
    if (!answer) {
      badAnswers.push(`#${entry.index} ${kind}: no scripted answer recorded for this request`);
      continue;
    }
    if (answer.status) badAnswers.push(`#${entry.index} ${kind}: answered HTTP ${answer.status} — ${answer.error}`);
    if (answer.finishReason === "length") badAnswers.push(`#${entry.index} ${kind}: the answer hit the output cap (finish_reason=length)`);
    if (answer.chars === 0 && answer.toolCalls.length === 0 && !answer.status) {
      badAnswers.push(`#${entry.index} ${kind}: answered with nothing (runOneShot throws on empty — a real run would fail here)`);
    }
  }
  if (badAnswers.length) fail("answer-shape", "a call came back broken.", badAnswers);
  else pass("answer-shape", "no error status, no output-cap truncation, no empty answer.");

  // ─── 12. The token-calibration probe is the shape measurePromptTokens promises ─
  const probes = byKind(CALIBRATION_KIND);
  const probeGaps = [];
  for (const { entry } of probes) {
    if (entry.messages.length !== 1) probeGaps.push(`#${entry.index}: the probe sent ${entry.messages.length} messages, expected exactly 1`);
    if (entry.messages.some((m) => m.role === "system")) probeGaps.push(`#${entry.index}: the probe sent a system prompt — it must be the sample alone`);
    if (entry.sampling.maxTokens !== 1) probeGaps.push(`#${entry.index}: the probe asked for max_tokens ${entry.sampling.maxTokens} — 0 is ignored by real servers and anything larger pays for a real answer`);
    if (!workflow.volumeForText(entry.userText)) probeGaps.push(`#${entry.index}: the probe is not measuring this series' own text`);
  }
  if (probeGaps.length) fail("calibration-probe", "the token-calibration probe is not the cheap, honest measurement it is supposed to be.", probeGaps);
  else pass("calibration-probe", `${probes.length} calibration probe(s): one user message of the volume's own text, no system prompt, max_tokens 1 — the server's usage count is the answer (gotcha 54).`);

  // ─── 13. A translation answer has the shape of the text it was given ─────────
  const shapeGaps2 = [];
  for (const { entry, kind } of translator) {
    const volume = workflow.volumeForText(entry.userText);
    if (!volume || !entry.answer) continue;
    const sourceParagraphs = workflow.sourceTextOf(volume).split("\n\n").length;
    if (entry.answer.paragraphs !== sourceParagraphs) {
      shapeGaps2.push(
        `#${entry.index} ${kind} volume ${volume.installment}: the source has ${sourceParagraphs} paragraphs and the answer has ` +
          `${entry.answer.paragraphs} — a paragraph was merged or dropped, which is what makes the targeted repair refuse its ` +
          `shortcut and costs a whole chapter of re-translation`
      );
    }
  }
  if (shapeGaps2.length) warn("translation-shape", "a translation reply does not line up paragraph-for-paragraph with its source.", shapeGaps2);
  else pass("translation-shape", `every translation reply matches its source paragraph-for-paragraph (the mapping the targeted repair depends on, gotcha 47).`);

  // ─── 14. A cumulative agent turn is told where the previous volume's artifact is
  const cumulativeTurnKinds = new Set([
    "glossary-author",
    "glossary-validator",
    "glossary-feedback",
    "voice-author",
    "voice-validator",
    "voice-feedback",
    "style-author",
    "style-validator",
    "style-feedback",
    "wiki-author",
    "wiki-validator",
    "wiki-feedback",
  ]);
  const pathGaps = [];
  for (const { entry, kind, volume } of identified) {
    if (!cumulativeTurnKinds.has(kind) || !volume) continue;
    const index = workflow.VOLUMES.indexOf(volume);
    if (index <= 0) continue;
    const previous = workflow.VOLUMES[index - 1];
    if (!entry.userText.includes(previous.folder)) {
      pathGaps.push(
        `#${entry.index} ${kind} volume ${volume.installment}: the prompt never names ${previous.folder} — the agent is not told ` +
          `where the artifact it must carry forward lives, so it either re-reads the wrong file or invents one`
      );
    }
  }
  if (pathGaps.length) fail("cumulative-reference-path", "an agent turn that must build on the previous volume was not given its path.", pathGaps);
  else pass("cumulative-reference-path", `every cumulative agent turn names the previous volume's folder, so the agent reads the real artifact instead of guessing at a path.`);

  // ─── 15. Every stage that is supposed to call the model did ─────────────────
  const idleStages = STAGE_ORDER.filter(
    (name) => !DETERMINISTIC_STAGES.has(name) && !identified.some((item) => item.entry.stage === name)
  );
  if (idleStages.length) {
    warn("stage-made-calls", `${idleStages.join(", ")} made no model call in the first pass — either it skipped everything or it never reached its live path.`, [
      "A stage with no call is the stage to read the log of: a live-only phase a dry run never reaches is exactly the class of bug gotcha 49 is about.",
    ]);
  } else {
    pass("stage-made-calls", `every stage that talks to the model made at least one call (${STAGE_ORDER.filter((n) => !DETERMINISTIC_STAGES.has(n)).length} stages; ${[...DETERMINISTIC_STAGES].join(", ")} is deterministic by design).`);
  }

  // ─── 16. Prompt sizes against the window the role is configured with ────────
  const window = Number(process.env.AI_CONTEXT_WINDOW || 32768);
  const oversized = [];
  const sizes = {};
  for (const { entry, kind } of identified) {
    sizes[kind] = Math.max(sizes[kind] || 0, entry.promptChars);
    // A rough token count: this fixture is CJK-heavy, and 0.62 tok/char is what the
    // live series measured. Anything past 60% of the window deserves a look.
    const roughTokens = Math.round(entry.promptChars * 0.62);
    if (roughTokens > window * 0.6) {
      oversized.push(`#${entry.index} ${kind}: ${entry.promptChars} chars ≈ ${roughTokens} tokens against a ${window}-token window`);
    }
  }
  if (oversized.length) warn("prompt-size", "a prompt used most of the model's context window.", oversized);
  else pass("prompt-size", `largest prompt per stage: ${Object.entries(sizes).map(([k, v]) => `${k} ${v}`).join(", ")} — all well inside the ${window}-token window.`);

  // ─── 14. The scripted brain had an answer for everything it was asked ───────
  const unknown = identified.filter((item) => item.kind === "unknown");
  if (unknown.length) {
    fail("unscripted-call", `${unknown.length} request(s) matched no stage prompt — the brain had nothing scripted for them.`, unknown.map((i) => `#${i.entry.index} model=${i.entry.model} tools=${i.entry.tools.length}: ${i.entry.messages.map((m) => m.text).join(" ").slice(0, 160)}`));
  } else {
    pass("unscripted-call", `every request matched a known stage prompt (${identified.length} requests, ${new Set(identified.map((i) => i.kind)).size} distinct kinds).`);
  }

  // ─── 18. Tools the model is offered but the sandbox will always refuse ──────
  const offered = new Map();
  for (const { entry, kind } of identified) {
    for (const tool of entry.tools) {
      if (!tool.name) continue;
      if (!offered.has(tool.name)) offered.set(tool.name, { kind, index: entry.index, count: 0 });
      offered.get(tool.name).count += 1;
    }
  }
  // `deleteFile` used to be in the tool set the harness hands an agent while the
  // approve gate denied it every time (the workflow deletes stale strays, never
  // the agent). Offering it is not dangerous — it is a wasted step and a promise
  // the sandbox will not keep, so the harness no longer advertises it
  // (`withoutDeleteFile` in harness.js). This rule is what keeps it from coming
  // back: any tool offered to an agent that the pipeline's own gate refuses.
  const refused = [...offered.entries()].filter(([name]) => name === "deleteFile");
  if (refused.length) {
    findings.push({
      rule: "advertised-but-refused-tool",
      severity: "info",
      detail: `${refused[0][1].count} agent request(s) advertise \`deleteFile\`, which the approve gate denies every time. The model can reach for it, get refused, and spend a step of a capped budget learning that it cannot.`,
      items: ["Not a bug: the denial is the sandbox (gotcha 8). The fix is not advertising a tool the agent may never use."],
    });
  } else {
    pass(
      "advertised-but-refused-tool",
      `the tool list and the sandbox agree: ${offered.size} distinct tool(s) offered, none of them one the gate would refuse.`
    );
  }

  const stats = {
    requests: pass1.length,
    kinds: identified.reduce((acc, item) => ((acc[item.kind] = (acc[item.kind] || 0) + 1), acc), {}),
    stages: identified.reduce((acc, item) => ((acc[item.entry.stage] = (acc[item.entry.stage] || 0) + 1), acc), {}),
    models: identified.reduce((acc, item) => ((acc[item.entry.model] = (acc[item.entry.model] || 0) + 1), acc), {}),
    toolCalls: identified.reduce((n, i) => n + ((i.entry.answer && i.entry.answer.toolCalls) || []).length, 0),
    promptChars: identified.reduce((n, i) => n + i.entry.promptChars, 0),
  };
  return { checks, findings, stats };
}

/**
 * The audit as a readable report.
 *
 * @param {{checks: Object[], findings: Object[], stats: Object}} audit
 * @returns {string}
 */
function renderAuditReport(audit) {
  const lines = [
    "# Prompt audit — what the pipeline actually asked the model",
    "",
    `Requests: ${audit.stats.requests} · tool calls: ${audit.stats.toolCalls} · prompt text: ${audit.stats.promptChars} characters`,
    "",
    "Calls per stage: " + Object.entries(audit.stats.stages).map(([k, v]) => `${k}=${v}`).join(", "),
    "Calls per model: " + Object.entries(audit.stats.models).map(([k, v]) => `${k}=${v}`).join(", "),
    "Calls per kind: " + Object.entries(audit.stats.kinds).map(([k, v]) => `${k}=${v}`).join(", "),
    "",
    `## Findings (${audit.findings.length})`,
    "",
  ];
  if (audit.findings.length === 0) {
    lines.push("None. Every rule below passed.");
  } else {
    for (const finding of audit.findings) {
      lines.push(`### [${finding.severity.toUpperCase()}] ${finding.rule}`);
      lines.push("");
      lines.push(finding.detail);
      for (const item of finding.items || []) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  lines.push("");
  lines.push(`## Checks that passed (${audit.checks.length})`);
  lines.push("");
  for (const check of audit.checks) {
    lines.push(`- **${check.rule}** — ${check.detail}`);
    for (const item of check.items || []) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

module.exports = { auditPromptLog, renderAuditReport, STAGE_ORDER, ONE_SHOT_KINDS, AGENT_KINDS };
