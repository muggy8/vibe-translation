/**
 * glossary/settlement/decide.js — ask the settled record's own questions, and file the answers
 * through the door that already exists.
 *
 * The pass is three steps, and only the middle one asks the model anything:
 *
 *   1. **code** reads the agenda out of the settled record (`agenda.js`) and out of its own decision
 *      file (`records.js`) — so a term already answered costs nothing;
 *   2. **one tool-less one-shot per unanswered term** says whether the settled rendering is still the
 *      right one now that the whole series has been read;
 *   3. **code** files a "yes, change it" answer through `importGlossaryRevisions` — the same revision
 *      door the glossary stage uses, with the same guard (the quote must be a line the flagging
 *      volume's own book prints) — and carries it to the settled record through the store's own
 *      top-up door.
 *
 * ## Why the filing goes into the flagging volume's record and then travels
 *
 * The revision door can only file into the record of the volume whose text carries the quote:
 * `insertFact` stamps `owner_volume` from the handle's frozen scope, `markSuperseded` requires a
 * successor row owned by that volume and stage, and `findQuoteEvidence` searches that volume's chapter
 * files. A decision about a term whose evidence is in volume 3 therefore has to be filed in volume 3.
 * The translator reads the **settled** record, so the decision then walks 3 → 4 → … → the settled
 * volume through `topUpVolumeRecord`, which is `INSERT OR IGNORE`: it adds rows, edits none, and
 * preserves row ids, so the `supersedes` link survives the trip.
 *
 * The consequence is stated rather than buried: a later volume's record ends up holding a row owned
 * by an earlier one, and re-rendering that later volume would print the settled rendering rather than
 * the one its published file prints. **No published per-volume file is touched by this pass.**
 *
 * ## What the pass does not do
 *
 * It does not edit a published row (the revision door files a new row beside the one it replaces, and
 * the old row survives marked `superseded`). It does not seal a record the acceptance gate left a
 * draft. It does not rewrite any volume's `glossary.md`. It runs nothing in parallel — the model
 * endpoint on this machine answers one request at a time (AGENTS.md §7), and a bounded pass that
 * fired its calls at the same instant would lengthen every wait and trip the harness's idle deadline.
 * It files no `cast_alias`, opens no dispute, and reaches no translation file.
 *
 * @module glossary/settlement/decide
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
require("../../types"); // JSDoc type definitions
const harness = require("../../harness");
const { structuralError } = require("../../configs/shared");
const {
  openVolumeRecord,
  sealVolumeRecord,
  importGlossaryRevisions,
  glossaryRowInForceForTerm,
  topUpVolumeRecord,
} = require("../../utils/reference-store");
const { settledGlossaryRecord, withSettledRecord } = require("../../utils/translate");
const { settlementAgenda, SETTLEMENT_MAX_TERMS_PER_RUN } = require("./agenda");
const {
  settlementRecordPaths,
  readSettlementDecisions,
  recordedDecision,
  decisionKey,
  decisionIdentityKeys,
  buildDecision,
  writeSettlementRecord,
  renderSettlementLog,
} = require("./records");

const projectRoot = path.resolve(__dirname, "../..");

/**
 * The settlement reading call's system prompt.
 *
 * A prompt file, like every other system prompt in this repository that a one-shot sends
 * (`system-prompts/glossary-terms.md`, `system-prompts/character-voice-detective.md`, …), so the text a
 * model is asked with is readable and diffable without opening the module that sends it.
 */
const SETTLEMENT_SYSTEM_PROMPT_FILE = path.join(projectRoot, "system-prompts", "glossary-settlement.md");

/**
 * Read the settlement system prompt.
 *
 * Read once per pass rather than once per term: a missing prompt is a defect of the install, not of one
 * term's question, and it is refused before any call is paid for.
 *
 * @returns {Promise<string>} The prompt text.
 * @throws {Error} A structural refusal when the prompt file cannot be read.
 */
async function readSettlementSystemPrompt() {
  try {
    return await fs.promises.readFile(SETTLEMENT_SYSTEM_PROMPT_FILE, "utf8");
  } catch (err) {
    throw structuralError(
      "[glossary-settlement] settlement-system-prompt-unreadable: " +
        `${SETTLEMENT_SYSTEM_PROMPT_FILE} could not be read (${String(err && err.message ? err.message : err)}). ` +
        "The settlement pass does not send a reading call with no system prompt behind it."
    );
  }
}

/**
 * The `response_format` payload for one settlement call.
 *
 * Declared beside {@link parseSettlementAnswer}, and object-rooted for the reason gotcha 138 records:
 * this endpoint refuses a `response_format` JSON Schema whose root is anything but an object (HTTP 400
 * in 161 ms, 0 tokens, before the model is asked). Closed (`additionalProperties: false`, `strict: true`)
 * because this prompt names every key of its element and prints its own example, which is the condition
 * `test/test-answer-envelopes.js` pins for a closed schema.
 *
 * @returns {Object} The `response_format` request field.
 */
function settlementResponseFormat() {
  return {
    type: "json_schema",
    json_schema: {
      name: "glossary_settlement_answer",
      strict: true,
      schema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["keep", "revise"] },
          rendering: { type: "string" },
          quote: { type: "string" },
          reason: { type: "string" },
        },
        required: ["decision", "rendering", "quote", "reason"],
        additionalProperties: false,
      },
    },
  };
}

/**
 * The reading prompt for one agenda term: the term, what the record says, and the lines it may quote.
 *
 * The quotable lines are the evidence the record already holds for this term **in the flagging
 * volume**. That is not a convenience: the revision door is going to search the flagging volume's own
 * chapter files for whatever the answer quotes, so a prompt that invited a quotation out of thin air
 * would produce a refusal on every term and a paid call for each one. The other volumes' evidence is
 * supplied as context and labelled as unquotable, because a rendering is often settled by a line the
 * reader needs to see but is not allowed to cite.
 *
 * @param {Object} item - One agenda item, plus `evidence` (`{quote, volume}[]`) and `superseded`.
 * @param {{targetLanguage: string}} values
 * @returns {string}
 */
function buildSettlementPrompt(item, { targetLanguage }) {
  const lines = [];
  lines.push(`Term: ${item.term}`);
  lines.push(`Current settled rendering: "${item.rendering}"`);
  if (item.section) lines.push(`Filed under: ${item.section}`);
  if (item.notes) lines.push(`What the glossary says about it: ${item.notes}`);
  if (Array.isArray(item.superseded) && item.superseded.length) {
    lines.push(`Renderings this term has already carried: ${item.superseded.map((r) => `"${r.rendering}" (in force from volume ${r.appliesFromVolume})`).join(", ")}`);
  }
  lines.push(`Why this term is on the agenda: ${item.because}`);
  lines.push("");
  lines.push(`The decision can only be filed into volume ${item.flaggingVolume}, so the line you quote must come from volume ${item.flaggingVolume}'s list below.`);
  lines.push("");

  const mine = (item.evidence || []).filter((ev) => Number(ev.volume) === Number(item.flaggingVolume));
  const others = (item.evidence || []).filter((ev) => Number(ev.volume) !== Number(item.flaggingVolume));
  lines.push(`Lines volume ${item.flaggingVolume}'s record holds as evidence for this term (the ONLY lines you may quote):`);
  if (mine.length) for (const ev of mine) lines.push(`- "${ev.quote}"`);
  else lines.push("- (none — this volume's record holds no quoted line for this term, so a change cannot be filed)");
  if (others.length) {
    lines.push("");
    lines.push("Lines earlier volumes hold (context only — you may NOT quote these):");
    for (const ev of others) lines.push(`- [volume ${ev.volume}] "${ev.quote}"`);
  }

  lines.push("");
  lines.push(
    "Answer with ONE JSON object, no prose around it and no code fence:\n" +
      "{\n" +
      '  "decision": "keep" or "revise",\n' +
      `  "rendering": the ${targetLanguage} rendering the series should use from now on — the current one when you keep it,\n` +
      '  "quote": one line from the quotable list above that supports the change, or "" when you keep it,\n' +
      '  "reason": 1-2 sentences a translator can read\n' +
      "}\n" +
      `"revise" owes a rendering DIFFERENT from "${item.rendering}" AND a quote from the quotable list. ` +
      "If the only support you have is the glossary's own note, answer \"keep\"."
  );
  return lines.join("\n");
}

/**
 * Read one settlement answer.
 *
 * Tolerant of a code fence and of a model that wraps the object in a sentence; strict about the two
 * things the filing door is going to ask about. An answer that cannot be read as a decision comes back
 * as `unusable` rather than as `keep`, because recording a refusal as an agreement is how a decision
 * file starts lying.
 *
 * @param {string} output - The model's reply.
 * @param {{currentRendering: string}} context - The rendering the settled record prints, for the same-rendering test.
 * @returns {{decision: "keep"|"revise"|"unusable", rendering: string, quote: string, reason: string, because: string}}
 */
function parseSettlementAnswer(output, { currentRendering }) {
  const text = String(output || "").trim();
  const unusable = (because) => ({ decision: "unusable", rendering: "", quote: "", reason: "", because });
  if (!text) return unusable("the settlement call returned an empty reply");

  let body = text;
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1].trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return unusable("the settlement call returned no JSON object");

  let parsed;
  try {
    parsed = JSON.parse(body.slice(first, last + 1));
  } catch {
    return unusable("the settlement call returned JSON that does not parse");
  }

  const decision = String(parsed.decision || "").trim().toLowerCase();
  const rendering = String(parsed.rendering || "").trim();
  const quote = String(parsed.quote || "").trim();
  const reason = String(parsed.reason || "").trim();
  if (decision !== "keep" && decision !== "revise") {
    return unusable(`the settlement call answered "${decision}", which is neither "keep" nor "revise"`);
  }
  if (!rendering) return unusable('the settlement call answered "revise" or "keep" with no rendering');
  if (decision === "revise" && !quote) {
    return unusable(
      `the settlement call asked to revise "${currentRendering}" without quoting a line, and a revision is ` +
        "only filed on the strength of a line the book prints"
    );
  }
  if (decision === "revise" && rendering === String(currentRendering || "").trim()) {
    return unusable(`the settlement call asked to revise "${currentRendering}" into the same words`);
  }
  return { decision, rendering, quote, reason, because: "" };
}

/**
 * The evidence lines the settled record holds for one term, across its whole supersede chain.
 *
 * Read straight out of the chain's rows: `publishedGlossaryRowsInRecord` returns the rows and their
 * ids but not their evidence, and the evidence column is where the quoted lines live. Each entry
 * carries the volume its quote was found in, which is what makes the prompt able to say which lines
 * are quotable for this filing and which are context.
 *
 * @param {{db: Object}} handle - The settled record, opened read-only.
 * @param {{id: string, superseded: Array<{id: string}>}} row - One settled row.
 * @returns {Array<{quote: string, volume: number|null}>}
 */
function chainEvidence(handle, row) {
  const ids = [row.id, ...(Array.isArray(row.superseded) ? row.superseded.map((r) => r.id) : [])].filter(Boolean);
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    const stored = handle.db.prepare("SELECT evidence FROM facts WHERE id = ?").get(id);
    if (!stored) continue;
    let spans = [];
    try {
      spans = JSON.parse(String(stored.evidence || "[]"));
    } catch {
      spans = [];
    }
    if (!Array.isArray(spans)) continue;
    for (const span of spans) {
      const quote = String((span && span.quote) || "").trim();
      if (!quote) continue;
      out.push({ quote, volume: span && span.volume !== undefined ? Number(span.volume) : null });
    }
  }
  // One line, once. A chain often cites the same sentence twice, and a prompt that printed it twice
  // invites an answer that quotes it twice and looks like it had two independent reasons.
  const seen = new Set();
  return out.filter((ev) => {
    const key = `${ev.volume}\u0000${ev.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Open one flagging volume's record, through the store's own front door.
 *
 * `openVolumeRecord` rather than `openReferenceStore`, because the front door is where the staleness
 * guard lives: a record copied from a volume that has since been reopened must not be written into,
 * and a settlement pass that skipped that check would file a decision into a record that no longer
 * describes the book and then propagate it forward.
 *
 * @param {Object} opts
 * @param {number} opts.volume
 * @param {string} opts.folder
 * @param {string} opts.seriesDir
 * @param {number|null} [opts.previousVolume]
 * @param {string|null} [opts.previousFolder]
 * @returns {{ok: boolean, store: Object|null, error: string|null}}
 */
function openFlaggingRecord({ volume, folder, seriesDir, previousVolume = null, previousFolder = null }) {
  const opened = openVolumeRecord({ volume, folder, seriesDir, previousVolume, previousFolder });
  if (opened.ok) return { ok: true, store: opened.store, error: null };
  return {
    ok: false,
    store: null,
    error: opened.refusal ? `${opened.refusal.rule}: ${opened.refusal.because}` : "the record could not be opened",
  };
}

/**
 * Carry a filed revision from the volume it was filed in up to the settled record.
 *
 * The store's own top-up door, one hop at a time, over the volumes the plan of record lists. It is
 * `INSERT OR IGNORE` on every counted table, so the only rows that move are the ones the destination
 * does not already have — which after this pass is the new revision row and nothing else.
 *
 * A missing volume in the middle of the chain stops the walk and is reported: a settled record that
 * never received the row is a settled record that still prints the old rendering, and the pass says so
 * rather than reporting a decision it did not deliver.
 *
 * @param {Object} opts
 * @param {number} opts.fromVolume - The volume the revision was filed into.
 * @param {number} opts.toVolume - The settled volume.
 * @param {string} opts.seriesDir
 * @param {(volume: number) => {folder: string, previousVolume: number|null, previousFolder: string|null}|null} locate - The plan's folder for one volume.
 * @returns {{carried: number[], refusal: string|null}}
 */
function carryRevisionForward({ fromVolume, toVolume, seriesDir, locate }) {
  const carried = [];
  let previous = fromVolume;
  for (let volume = fromVolume + 1; volume <= toVolume; volume += 1) {
    const here = locate(volume);
    const before = locate(previous);
    if (!here || !before) {
      return { carried, refusal: `volume ${volume} (or ${previous}) is not a volume this run's plan of record lists, so the decision cannot reach volume ${toVolume}` };
    }
    const topped = topUpVolumeRecord({
      fromVolume: previous,
      toVolume: volume,
      seriesDir,
      fromFolder: before.folder,
      toFolder: here.folder,
      step: "glossary-settlement",
    });
    if (!topped.ok) {
      return { carried, refusal: `${topped.refusal.rule}: ${topped.refusal.because}` };
    }
    carried.push(volume);
    previous = volume;
  }
  return { carried, refusal: null };
}

/**
 * File one "revise" answer through the revision door, and carry it to the settled record.
 *
 * @param {Object} opts
 * @param {Object} opts.item - The agenda item.
 * @param {Object} opts.answer - The parsed answer.
 * @param {Object} opts.store - The flagging volume's open record.
 * @param {Object} opts.settled - The settled record descriptor.
 * @param {string} opts.seriesDir
 * @param {Function} opts.locate
 * @returns {{filed: boolean, replacedRendering: string, propagatedTo: number[], settled: boolean, rule: string|null, because: string|null}}
 */
function fileAndCarry({ item, answer, store, settled, seriesDir, locate }) {
  const filed = importGlossaryRevisions(
    store,
    [{ term: item.term, rendering: answer.rendering, note: answer.reason, quote: answer.quote, reason: answer.reason }],
    { volume: item.flaggingVolume }
  );
  if (!filed.filed.length) {
    const refusal = filed.refused[0] || null;
    return {
      filed: false,
      replacedRendering: "",
      propagatedTo: [],
      settled: false,
      rule: refusal ? refusal.rule : "revision-not-filed",
      because: refusal ? refusal.because : "the revision door filed nothing",
    };
  }

  // Seal the new row only when this volume's record was already sealed. A volume the acceptance gate
  // left a draft stays a draft: the settlement is not the door that publishes a record nobody signed
  // off, and `reference-volume-unsealed` is the HIGH finding that exists to stop exactly that.
  if (store.isVolumeSealed(store.volume)) sealVolumeRecord(store);

  const replaced = filed.replaced[0] || {};
  const carried =
    item.flaggingVolume === settled.volume
      ? { carried: [], refusal: null }
      : carryRevisionForward({ fromVolume: item.flaggingVolume, toVolume: settled.volume, seriesDir, locate });

  // The delivery is asked of the settled record, not of the filing's own return value. A chain that
  // dropped a hop, a row that arrived under a term the settled record spells differently — either one
  // would leave the translator reading the old rendering while the log said the decision was made.
  const settledNow = withSettledRecord({ seriesDir, record: settled }, (handle) => {
    const row = glossaryRowInForceForTerm(handle, item.term, settled.volume);
    return row ? String(row.rendering || "").trim() : "";
  });

  return {
    filed: true,
    replacedRendering: String(replaced.rendering || item.rendering),
    propagatedTo: carried.carried,
    settled: settledNow === answer.rendering,
    rule: carried.refusal ? "revision-not-carried-to-the-settled-record" : null,
    because: carried.refusal || null,
  };
}

/**
 * The default model call: one bounded, tool-less, shaped one-shot.
 *
 * Kept behind a parameter in {@link runSettlementPass} so the offline suite can stand a scripted answer
 * in front of it without this module knowing the difference. The stage never passes one.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.prompt
 * @param {string} opts.label
 * @param {Object} opts.responseFormat
 * @returns {Promise<string>} The model's reply.
 */
async function defaultSettlementAsk({ systemPrompt, prompt, label, responseFormat }) {
  return harness.runOneShot({ systemPrompt, messages: [{ text: prompt }], label, responseFormat });
}

/**
 * Work out what a settlement pass WOULD do, without asking the model anything or writing anything.
 *
 * Split out because the freeze gate asks "would this act rewrite something?", and the only honest
 * answer to that question needs the agenda and the already-recorded decisions in hand. A door that
 * answered "yes, it rewrites" merely because it was asked would refuse a run that changes nothing —
 * which is the refusal the offline loop's second pass hit the first time this pass was wired in.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {Array<{folder: string, installmentNumber: number}>} opts.volumeRefs - Every volume this run's plan lists, with its folder.
 * @param {{limit?: number}} [options] - `limit` overrides the bound for a measurement; a run never passes it.
 * @returns {{settled: Object, locate: Function, agenda: Object, pending: Array<Object>, stored: Object, paths: Object}}
 * @throws {Error} A structural refusal when the series has no readable settled record.
 */
function planSettlementPass({ seriesDir, volumeRefs }, { limit = SETTLEMENT_MAX_TERMS_PER_RUN } = {}) {
  const settled = settledGlossaryRecord({ seriesDir });
  /** @type {Map<number, {folder: string, previousVolume: number|null, previousFolder: string|null}>} */
  const byVolume = new Map();
  const orderedRefs = [...volumeRefs].sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber));
  orderedRefs.forEach((ref, index) => {
    const previous = index > 0 ? orderedRefs[index - 1] : null;
    byVolume.set(Number(ref.installmentNumber), {
      folder: ref.folder,
      previousVolume: previous ? Number(previous.installmentNumber) : null,
      previousFolder: previous ? previous.folder : null,
    });
  });
  /**
   * The plan's folder for one volume, or null when the plan does not list it.
   * @param {number} volume
   */
  const locate = (volume) => byVolume.get(Number(volume)) || null;

  const agenda = withSettledRecord({ seriesDir, record: settled }, (handle) => settlementAgenda(handle, { limit }));
  const paths = settlementRecordPaths(seriesDir);
  const stored = readSettlementDecisions(paths.json);
  const pending = agenda.agenda.filter((item) => !recordedDecision(stored.byKey, item));
  // Questions a previous pass asked and could not answer. They are pending again by rule, and they are
  // counted separately so a run can see "never asked" apart from "asked and never answered".
  const owed = pending.filter((item) =>
    stored.unanswered.some((entry) => decisionIdentityKeys(entry).includes(decisionKey({ term: item.term, flaggingVolume: item.flaggingVolume, currentRendering: item.rendering })))
  );

  console.log(
    `[glossary-settlement] agenda: ${agenda.candidateCount} term(s) (${agenda.chainCount} already revised, ` +
      `${agenda.forwardCount} whose own note points forward) from ${settled.folder} (volume ${settled.volume}). ` +
      `The bound is ${agenda.limit} terms per run.` +
      `${agenda.skipped.length ? ` ${agenda.skipped.length} cut by the bound.` : ""}` +
      ` ${pending.length} question(s) have never been answered` +
      `${owed.length ? ` (${owed.length} of them asked before and never answered).` : "."}`
  );
  if (stored.error) console.error(`[glossary-settlement] ${stored.error}`);
  if (agenda.skipped.length) {
    console.warn(
      `[glossary-settlement] the bound will not pay for ${agenda.skipped.length} candidate(s): ` +
        `${agenda.skipped.map((item) => item.term).join(", ")}. They are named in ${paths.markdown}.`
    );
  }

  return { seriesDir, settled, locate, agenda, pending, stored, paths };
}

/**
 * Run a planned settlement pass: ask the unanswered questions, file what comes back, write the records.
 *
 * @param {Object} plan - A {@link planSettlementPass} result.
 * @param {{values: Object, ask?: Function}} [options] - `ask` stands where the model stands (the offline suite passes a fixture); the stage never passes one.
 * @returns {Promise<{ran: boolean, agendaCount: number, asked: number, carriedOver: number, revised: number, kept: number, refused: number, skipped: Array<Object>, limit: number, capped: boolean, settled: Object, files: {json: string, markdown: string}, decisions: Array<Object>}>}
 */
async function executeSettlementPass(plan, { values, ask = defaultSettlementAsk } = {}) {
  const { settled, locate, agenda, stored, paths } = plan;
  const seriesDir = plan.seriesDir;

  /** @type {Array<Object>} */
  const decisions = [];
  /** @type {Map<number, Object>} volume → its open record, opened once and closed at the end. */
  const openStores = new Map();
  const systemPrompt = await readSettlementSystemPrompt();
  let asked = 0;
  let carriedOver = 0;
  let revised = 0;
  let kept = 0;
  let refused = 0;
  /** Agenda questions this pass left open: a reading call that never brought back a decision. */
  let open = 0;

  for (const item of agenda.agenda) {
    const already = recordedDecision(stored.byKey, item);
    if (already) {
      carriedOver += 1;
      decisions.push({ ...already, carriedOver: true });
      continue;
    }

    // A previous pass asked this term and never got an answer back. Say so before paying again: the
    // re-pay is the point of gotcha 138, and a silent re-ask is the hole it names.
    const owed = stored.unanswered.find((entry) => decisionIdentityKeys(entry).includes(decisionKey({ term: item.term, flaggingVolume: item.flaggingVolume, currentRendering: item.rendering })));
    if (owed) {
      console.warn(
        `[glossary-settlement] "${item.term}": asked again — the last pass could not answer it (${owed.refusalRule}: ${owed.refusalBecause}). ` +
          `A reading call that never brought back a decision is a failed read, not an answer.`
      );
    }

    const located = locate(item.flaggingVolume);
    if (!located) {
      decisions.push(
        buildDecision(item, { decision: "unreachable", rendering: item.rendering, quote: "", reason: "" }, {
          asked: false,
          filed: { filed: false, rule: "flagging-volume-not-in-the-plan", because: `volume ${item.flaggingVolume} is not a volume this run's plan of record lists, so its record cannot be opened to file a revision in.` },
        })
      );
      open += 1;
      continue;
    }

    const evidence = withSettledRecord({ seriesDir, record: settled }, (handle) => {
      const row = glossaryRowInForceForTerm(handle, item.term, settled.volume);
      return row ? { evidence: chainEvidence(handle, row), superseded: row.superseded || [] } : { evidence: [], superseded: [] };
    });
    const fullItem = { ...item, evidence: evidence.evidence, superseded: evidence.superseded };
    const prompt = buildSettlementPrompt(fullItem, { targetLanguage: values.TARGET_LANGUAGE });

    let answer;
    try {
      const output = await ask({
        item: fullItem,
        prompt,
        systemPrompt,
        label: `glossary-settlement-${settled.volume}-${String(item.term).slice(0, 20)}`,
        responseFormat: settlementResponseFormat(),
      });
      answer = parseSettlementAnswer(output, { currentRendering: item.rendering });
    } catch (err) {
      answer = { decision: "unusable", rendering: "", quote: "", reason: "", because: `the settlement call failed: ${String(err && err.message ? err.message : err)}` };
    }
    asked += 1;

    if (answer.decision === "unusable") {
      decisions.push(
        buildDecision(item, answer, {
          asked: true,
          filed: { filed: false, rule: "settlement-answer-unusable", because: answer.because },
        })
      );
      open += 1;
      console.warn(
        `[glossary-settlement] "${item.term}": the reading call's answer was not usable — ${answer.because}. ` +
          `The term keeps its rendering and the question stays OPEN: the next pass asks it again.`
      );
      continue;
    }

    if (answer.decision === "keep") {
      decisions.push(buildDecision(item, answer, { asked: true }));
      kept += 1;
      console.log(`[glossary-settlement] "${item.term}": kept "${item.rendering}".`);
      continue;
    }

    let handle = openStores.get(item.flaggingVolume);
    if (!handle) {
      const opened = openFlaggingRecord({ volume: item.flaggingVolume, folder: located.folder, seriesDir, previousVolume: located.previousVolume, previousFolder: located.previousFolder });
      if (!opened.ok) {
        decisions.push(
          buildDecision(item, answer, {
            asked: true,
            filed: { filed: false, rule: "flagging-record-refused", because: opened.error },
          })
        );
        refused += 1;
        console.error(`[glossary-settlement] "${item.term}": volume ${item.flaggingVolume}'s record refused to open — ${opened.error}`);
        continue;
      }
      handle = opened.store;
      openStores.set(item.flaggingVolume, handle);
    }

    const outcome = fileAndCarry({ item, answer, store: handle, settled, seriesDir, locate });
    decisions.push(buildDecision(item, answer, { asked: true, filed: outcome }));
    if (outcome.filed) {
      revised += 1;
      console.log(
        `[glossary-settlement] "${item.term}": revised "${outcome.replacedRendering}" → "${answer.rendering}" in volume ${item.flaggingVolume}` +
          `${outcome.propagatedTo.length ? `, carried into ${outcome.propagatedTo.map((v) => `volume ${v}`).join(", ")}` : ""}` +
          `${outcome.settled ? " — the settled record now prints it." : ""}`
      );
      if (!outcome.settled && outcome.rule) {
        console.error(`[glossary-settlement] "${item.term}": ${outcome.rule}: ${outcome.because}`);
      }
    } else {
      refused += 1;
      console.error(`[glossary-settlement] "${item.term}": the revision door refused it — ${outcome.rule}: ${outcome.because}`);
    }
  }

  for (const store of openStores.values()) {
    try {
      store.close();
    } catch {
      /* a handle that will not close after its writes are committed cannot leave a record half-changed */
    }
  }

  const written = writeSettlementRecord({
    file: paths.json,
    settled,
    limit: agenda.limit,
    decisions,
    skipped: agenda.skipped,
  });
  if (!written.written) console.error(`[glossary-settlement] could not write ${written.file} (${written.error}) — the next pass will pay for these decisions again.`);

  const log = renderSettlementLog(
    {
      settled,
      limit: agenda.limit,
      agendaCount: agenda.agenda.length,
      chainCount: agenda.chainCount,
      forwardCount: agenda.forwardCount,
      skipped: agenda.skipped,
    },
    decisions
  );
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.markdown, log, "utf8");
  } catch (err) {
    console.error(`[glossary-settlement] could not write ${paths.markdown} (${String(err && err.message ? err.message : err)}).`);
  }

  console.log(
    `[glossary-settlement] ${asked} reading call(s) for ${agenda.agenda.length} agenda term(s) ` +
      `(${carriedOver} already answered, ${revised} revised, ${kept} kept, ${refused} refused` +
      `${open ? `, ${open} never answered — asked again next pass` : ""}).`
  );

  return {
    ran: true,
    agendaCount: agenda.agenda.length,
    asked,
    carriedOver,
    revised,
    kept,
    refused,
    open,
    skipped: agenda.skipped,
    limit: agenda.limit,
    capped: agenda.capped,
    settled,
    files: { json: paths.json, markdown: paths.markdown },
    decisions,
  };
}

/**
 * Plan and run a settlement pass in one call.
 *
 * The door a caller that does not need to know the agenda in advance uses. `glossary/settlement.js`
 * uses the two halves separately, because the freeze gate has to be asked between them: the plan says
 * how many questions have never been asked, and that is what makes the difference between an act that
 * rewrites the terminology law and an act that rewrites nothing.
 *
 * @param {Object} opts
 * @param {string} opts.seriesDir - Absolute series folder.
 * @param {Array<{folder: string, installmentNumber: number}>} opts.volumeRefs - Every volume this run's plan lists, with its folder.
 * @param {{SOURCE_NAME: string, SOURCE_LANGUAGE: string, TARGET_LANGUAGE: string}} opts.values
 * @param {{ask?: Function, limit?: number}} [options] - `ask` stands where the model stands (the offline suite passes a fixture); `limit` overrides the bound for a measurement, and a run never passes it.
 * @returns {Promise<Object>} The {@link executeSettlementPass} result.
 * @throws {Error} A structural refusal when the series has no readable settled record — the pass has nothing to ask, and reporting a settlement it never made is the failure this gate exists to prevent.
 */
async function runSettlementPass({ seriesDir, volumeRefs, values }, { ask = defaultSettlementAsk, limit } = {}) {
  const plan = planSettlementPass({ seriesDir, volumeRefs }, limit === undefined ? {} : { limit });
  return executeSettlementPass(plan, { values, ask });
}

module.exports = {
  SETTLEMENT_SYSTEM_PROMPT_FILE,
  readSettlementSystemPrompt,
  settlementResponseFormat,
  buildSettlementPrompt,
  parseSettlementAnswer,
  chainEvidence,
  openFlaggingRecord,
  carryRevisionForward,
  fileAndCarry,
  defaultSettlementAsk,
  planSettlementPass,
  executeSettlementPass,
  runSettlementPass,
};
