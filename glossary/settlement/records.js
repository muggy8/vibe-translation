/**
 * glossary/settlement/records.js — the settlement pass's own two files, and the rule that makes a
 * second pass cost nothing.
 *
 * The pass asks the model one bounded question per agenda term. That is only tolerable if asking it
 * twice is not necessary, so the pass keeps a **machine twin of its own decisions**:
 *
 *   `glossary-settlement.json` — one entry per agenda identity, each carrying the answer, what was
 *   filed, what was refused, and the rendering the settled record printed when the question was asked.
 *   `glossary-settlement.md` — the same decisions in the shape a person reads, including the terms the
 *   bound refused to pay for.
 *
 * ## The identity, and why a second pass pays 0 calls
 *
 * An agenda identity is **(term, flagging volume, the rendering the settled record prints for it now)**.
 * A call is paid only for an identity the record has no *answer* for. What closes an identity is one
 * question, asked of the entry alone: **did the reading call bring back an answer the parser could read
 * as a decision?**
 *
 *   - **`keep`** — answered. The record still prints the same rendering, the identity matches, 0 calls.
 *   - **`revise`, filed** — answered, and it answers **two** identities: the rendering the pass was
 *     asked about, and the rendering the settled record prints now. {@link decisionIdentityKeys} derives
 *     both from the entry, so the next pass — whose agenda item carries the *new* rendering — matches the
 *     second one and pays 0. Without that second key the pass re-asks the term it just settled, which is
 *     what this file's first version did and what `test/test-glossary-settlement.js` now pins from both
 *     sides. The alias is derived, never stored, so a record written before the alias existed gains it
 *     the moment it is read.
 *   - **`revise`, refused by the revision door** (`revision-quote-not-in-source`,
 *     `revision-of-unknown-term`) — answered. The question was asked, the answer is on file, and the rule
 *     that refused it is named. Re-asking with the same inputs pays a call to collect the same refusal.
 *   - **`revise`, filed but never carried to the settled record** — answered. The settled record still
 *     prints the old rendering, so the old identity still matches and the failure is named in the log
 *     rather than re-paid for.
 *   - **An answer that never arrived** — the call threw, or the reply was not a decision the parser could
 *     read (`unusable`) — **is not an answer.** The entry is written, so the log names the term and the
 *     cost it already spent, but it closes nothing and the next pass asks the term again. This is
 *     AGENTS.md gotcha 138 in a new place: a read that never answered must not look like a question that
 *     needed no asking. `glossary/extract.js`'s `EXTRACTION_MAX_ATTEMPTS` and
 *     `character-voice/reading.js` apply the same rule inside one pass; this is the same rule across two
 *     passes. The re-pay is bounded by `SETTLEMENT_MAX_TERMS_PER_RUN`, and every re-asked term is named.
 *   - **A question the pass could not ask at all** (`flagging-volume-not-in-the-plan`) — not an answer
 *     either. No call was paid, so re-trying costs nothing, and a later run whose plan of record lists
 *     the volume should settle the term rather than inherit a refusal it never got the chance to make.
 *
 * A term whose rendering changed because a *volume re-ran* and filed a different revision matches neither
 * its old identity nor this pass's alias, so it is asked again. That is correct: it is a different
 * question.
 *
 * ## The other thing these files have to get right: what the agenda could not read
 *
 * The agenda has a structural half (a rendering a later volume already replaced) and a **vocabulary** half
 * (a note that promises the book has not finished making). The vocabulary half is written in one script,
 * and a note written in another is invisible to it. A log that prints only `0 terms point forward` cannot
 * tell "this series has nothing to settle" from "the phrases we can match are not written in the language
 * these notes are written in" — and the second one is the failure plan 07 §4.8 exists to prevent, because
 * the notes move into the language of the book the moment the extraction prompt asks for them there.
 *
 * So both files carry the coverage as its own record: `noteRule` in the JSON and a named section in the
 * markdown, each stating the state (`covered` / `partially-blind` / `blind` / `no-notes`), how many notes
 * were read, how many the vocabulary could not read, which vocabulary was in force (the shipped shapes,
 * plus whatever markers this series declared), and a sentence saying what the count therefore is. A pass
 * that reports no coverage at all writes `not-reported` rather than an empty section, because an absent
 * key reads exactly like a clean bill of health.
 *
 * ## Where these files live, and why not in a volume folder
 *
 * In the run's own records (`<series>/.run/postmortem/`), which is where the `extract` step's reports
 * already live. They are the run's memory, not a deliverable: they are committed with the books so
 * another machine can continue the run without re-paying for the decisions, and they are not in the
 * series root, where the intake's folder scan would have to learn to ignore them. They are
 * deliberately **not** declared in `utils/artifacts/preproduction.js`, which means the post-mortem
 * does not check them and a settlement finding cannot reach the delivery layer — the same hole
 * AGENTS.md gotcha 138 records, and closing it is an owner decision.
 *
 * @module glossary/settlement/records
 */

const fs = require("fs");
const path = require("path");

const { configuredDir, RUN_DIR_NAME, RUN_STATE_SUBDIRS } = require("../../configs/run-state");
const { REFERENCE_STORE_FILE_NAME } = require("../../utils/reference-store");
require("../../types"); // JSDoc type definitions

/** The machine twin of the decisions. */
const SETTLEMENT_JSON_FILE = "glossary-settlement.json";
/** The same decisions, for a person. */
const SETTLEMENT_MD_FILE = "glossary-settlement.md";

/**
 * The record's own shape version. Bumped only when an existing entry would be read wrongly.
 *
 * Not bumped by the 2026-10-13 idempotency fix, and that is deliberate: what changed is the RULE that
 * decides whether an entry closes its agenda identity ({@link decisionClosesQuestion} and
 * {@link decisionIdentityKeys}), and both read fields every entry already carried. A record written by
 * the first version of this pass is therefore read correctly by the new rule rather than re-paid for.
 *
 * Not bumped by the 2026-10-15 coverage fields either, for the same reason: `agenda`, `noteRule` and
 * `markerDeclaration` sit **beside** `decisions`, and {@link decisionClosesQuestion} and
 * {@link decisionIdentityKeys} still read only entry fields. A record written before the coverage existed
 * is read correctly by a pass that now reports it — and {@link NOTE_RULE_NOT_REPORTED} is what a reader
 * sees when a file genuinely has no coverage to read, rather than a silence that looks like a clean result.
 *
 * @type {number}
 */
const SETTLEMENT_RECORD_SCHEMA = 1;

/**
 * The decisions that are NOT answers.
 *
 * `unusable` — the reading call threw, or its reply could not be read as a decision. `unreachable` — the
 * pass never got to ask, because the volume that owns the term is not in this run's plan of record. Both
 * are recorded so a person can see them and so the cost already spent is visible, and neither closes the
 * question: a question nobody answered must not look like a question that needed no asking (AGENTS.md
 * gotcha 138), which is the same reason `glossary/extract.js` re-reads a term list that never arrived.
 *
 * @type {Set<string>}
 */
const UNANSWERED_DECISIONS = new Set(["unusable", "unreachable"]);

/**
 * Whether one recorded entry is an answer to the question it was recorded for.
 *
 * Derived from the entry's own `decision` rather than from a flag the writer could set wrong, so a record
 * written by an earlier pass is read by the same rule as one written now.
 *
 * @param {Object} entry - One `glossary-settlement.json` entry.
 * @returns {boolean} True when the question is closed and the next pass does not pay for it again.
 */
function decisionClosesQuestion(entry) {
  const decision = String((entry && entry.decision) || "").trim().toLowerCase();
  if (!decision) return false;
  return !UNANSWERED_DECISIONS.has(decision);
}

/**
 * Every agenda identity one entry answers.
 *
 * The base identity is the rendering the settled record printed when the question was asked. A revision
 * that was **filed and confirmed in the settled record** also answers the identity of the rendering it
 * chose, because that is the rendering the next pass's agenda item now carries — and the honest answer on
 * file for it is "this one; this pass chose it from this evidence". Without that second key the pass
 * re-asks the term it just settled, which is what this file's first version did.
 *
 * The alias is **derived, never stored**: every field it needs (`term`, `flaggingVolume`,
 * `currentRendering`, `chosenRendering`, `filed`, `settled`) is one an entry already carried, so a record
 * written before the alias existed gains it the moment it is read instead of paying a call again.
 *
 * @param {Object} entry - One `glossary-settlement.json` entry.
 * @returns {string[]} The identity keys this entry closes, base first, no duplicates.
 */
function decisionIdentityKeys(entry) {
  if (!entry) return [];
  const term = entry.term;
  const flaggingVolume = entry.flaggingVolume;
  const printed = String(entry.currentRendering || "").trim();
  const keys = [decisionKey({ term, flaggingVolume, currentRendering: printed })];
  const chosen = String(entry.chosenRendering || "").trim();
  if (entry.filed === true && entry.settled === true && chosen && chosen !== printed) {
    const alias = decisionKey({ term, flaggingVolume, currentRendering: chosen });
    if (!keys.includes(alias)) keys.push(alias);
  }
  return keys;
}


/**
 * Where the settlement pass writes, under a series.
 *
 * `POSTMORTEM_DIR` wins outright, exactly as the ledger, the tickets and the extraction reports
 * resolve themselves; otherwise it is the run's records folder beside this series. The series is
 * passed in rather than read from the environment, so a test pointed at a fixture cannot end up
 * writing next to the books.
 *
 * @param {string} seriesDir - Absolute series folder.
 * @returns {{dir: string, json: string, markdown: string}}
 */
function settlementRecordPaths(seriesDir) {
  const dir = configuredDir("POSTMORTEM_DIR") || path.join(String(seriesDir), RUN_DIR_NAME, RUN_STATE_SUBDIRS.postmortem);
  return { dir, json: path.join(dir, SETTLEMENT_JSON_FILE), markdown: path.join(dir, SETTLEMENT_MD_FILE) };
}

/**
 * The identity of one agenda question.
 *
 * Term + flagging volume + the rendering the settled record prints right now. The rendering is in the
 * key because the question is about it: when the record's answer to a term changes, the old answer is
 * no longer an answer to the current question.
 *
 * @param {{term: string, flaggingVolume: number|string, currentRendering: string}} item
 * @returns {string}
 */
function decisionKey({ term, flaggingVolume, currentRendering }) {
  return [String(term || "").trim(), String(flaggingVolume), String(currentRendering || "").trim()].join("\u0000");
}

/**
 * The decisions a previous pass already recorded.
 *
 * An unreadable or absent record is **not** an error that stops the run: it means "nothing has been
 * decided yet", which is the state of a first run. A record that exists but cannot be parsed is
 * reported, because silently starting over would re-pay for every decision the series already made —
 * and the caller prints that rather than swallowing it.
 *
 * Only entries that are **answers** are indexed ({@link decisionClosesQuestion}), and an answer is
 * indexed under every identity it closes ({@link decisionIdentityKeys}). A failed read stays in
 * `decisions` — so the log can name it and the cost it already spent is visible — and is absent from
 * `byKey`, so the next pass asks the term again.
 *
 * @param {string} file - Absolute path to `glossary-settlement.json`.
 * @returns {{decisions: Array<Object>, byKey: Map<string, Object>, unanswered: Array<Object>, error: string|null, present: boolean}}
 *   `unanswered` is the entries that are on file but close nothing — the questions this series still owes.
 */
function readSettlementDecisions(file) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { decisions: [], byKey: new Map(), unanswered: [], error: null, present: false };
  }
  try {
    const parsed = JSON.parse(raw);
    const decisions = Array.isArray(parsed && parsed.decisions) ? parsed.decisions : [];
    /** @type {Map<string, Object>} */
    const byKey = new Map();
    /** @type {Array<Object>} */
    const unanswered = [];
    for (const entry of decisions) {
      if (!decisionClosesQuestion(entry)) {
        unanswered.push(entry);
        continue;
      }
      for (const key of decisionIdentityKeys(entry)) byKey.set(key, entry);
    }
    return { decisions, byKey, unanswered, error: null, present: true };
  } catch (err) {
    return {
      decisions: [],
      byKey: new Map(),
      unanswered: [],
      error: `${file} exists but is not readable JSON (${String(err && err.message ? err.message : err)}). ` +
        "The pass cannot tell which decisions this series already made, so it will pay for them again.",
      present: true,
    };
  }
}

/**
 * The entry for one agenda item, when a previous pass already answered it.
 *
 * @param {Map<string, Object>} byKey - {@link readSettlementDecisions}'s index.
 * @param {Object} item - An agenda item, read for its `term` / `flaggingVolume` / `rendering`.
 * @returns {Object|null} The recorded decision, or null when nobody has asked this question yet.
 */
function recordedDecision(byKey, item) {
  return byKey.get(decisionKey({ term: item.term, flaggingVolume: item.flaggingVolume, currentRendering: item.rendering })) || null;
}

/**
 * One decision, in the shape the record stores.
 *
 * `agenda` names **which half** put the term on the agenda, and the two halves of the note half are named
 * apart on purpose: `forward-note` means the shipped vocabulary read it, `declared-marker` means the
 * series' own declared phrase read it. A record that could not tell those two apart could not tell a
 * covered agenda from a lucky one.
 *
 * @param {Object} item - The agenda item.
 * @param {Object} answer - What the pass decided: `{decision, rendering, quote, reason}`.
 * @param {Object} [opts]
 * @param {Object} [opts.filed] - What the revision door did: `{filed, rule, because, replacedRendering, propagatedTo, settled}`.
 * @param {boolean} [opts.asked] - Whether this entry is a decision this pass made, as opposed to one it carried over.
 * @returns {Object}
 */
function buildDecision(item, answer, { filed, asked } = {}) {
  const markers = Array.isArray(item.markers) ? item.markers : [];
  return {
    key: decisionKey({ term: item.term, flaggingVolume: item.flaggingVolume, currentRendering: item.rendering }),
    term: item.term,
    section: item.section,
    flaggingVolume: item.flaggingVolume,
    currentRendering: item.rendering,
    agenda: [item.chain ? "chain" : null, item.shapes.length ? "forward-note" : null, markers.length ? "declared-marker" : null].filter(Boolean),
    shapes: item.shapes,
    markers,
    because: item.because,
    asked: asked === undefined ? answer.asked === true : asked === true,
    decision: answer.decision,
    chosenRendering: String(answer.rendering || "").trim(),
    quote: String(answer.quote || "").trim(),
    reason: String(answer.reason || "").trim(),
    filed: Boolean(filed && filed.filed),
    replacedRendering: filed ? String(filed.replacedRendering || "").trim() : "",
    refusalRule: filed && filed.rule ? String(filed.rule) : null,
    refusalBecause: filed && filed.because ? String(filed.because) : null,
    propagatedTo: filed && Array.isArray(filed.propagatedTo) ? filed.propagatedTo : [],
    settled: Boolean(filed && filed.settled),
    decidedAt: new Date().toISOString(),
  };
}

/**
 * The note half could not be reported. Named rather than left out, because the invariant this pass is
 * held to is that an agenda nobody could ask must never be readable as an agenda that found nothing — and
 * a JSON file with no `noteRule` key is exactly that reading.
 *
 * @type {Object}
 */
const NOTE_RULE_NOT_REPORTED = {
  state: "not-reported",
  askable: false,
  vocabularyScripts: [],
  notesRead: 0,
  notesOutsideVocabulary: 0,
  notesWithNoLetters: 0,
  outsideExamples: [],
  markerCount: 0,
  markersThatFiredOnNothing: [],
  rowsFiredByShapes: 0,
  rowsFiredByMarkers: 0,
  because:
    "this record was written without the note half's coverage, so nothing in this file can tell an agenda " +
    "that found nothing apart from an agenda that could not be asked.",
};

/**
 * The decision record, written.
 *
 * Written whole rather than appended: the file is the index the next pass reads, and a file that has
 * to be repaired before it can be read is a file that gets deleted.
 *
 * @param {Object} opts
 * @param {string} opts.file - Absolute path to `glossary-settlement.json`.
 * @param {Object} opts.settled - The settled record this pass read.
 * @param {number} opts.limit - The bound that was in force.
 * @param {Array<Object>} opts.decisions - Every entry, newly decided and carried over.
 * @param {Array<Object>} opts.skipped - The agenda terms the bound cut.
 * @param {{candidateCount: number, chainCount: number, forwardCount: number}} [opts.agendaCounts] - What the agenda was made of.
 * @param {Object} [opts.textRule] - The {@link forwardRuleCoverage} result for this pass — what the note
 *   half could actually read. Absent is written as {@link NOTE_RULE_NOT_REPORTED}, never as nothing.
 * @param {Object} [opts.declaration] - The series' declared marker block as read (`declared` / `empty` /
 *   `absent` / `malformed`), so a later reader can tell which vocabulary was in force.
 * @returns {{written: boolean, file: string, error: string|null}}
 */
function writeSettlementRecord({ file, settled, limit, decisions, skipped, agendaCounts, textRule, declaration }) {
  const rule = textRule || NOTE_RULE_NOT_REPORTED;
  const body = {
    schema: SETTLEMENT_RECORD_SCHEMA,
    writtenAt: new Date().toISOString(),
    settledRecord: { folder: settled.folder, volume: settled.volume, file: settled.file },
    limit,
    agenda: {
      candidates: agendaCounts ? Number(agendaCounts.candidateCount) : decisions.length,
      chain: agendaCounts ? Number(agendaCounts.chainCount) : null,
      forward: agendaCounts ? Number(agendaCounts.forwardCount) : null,
    },
    noteRule: {
      state: rule.state,
      askable: rule.askable === true,
      vocabularyScripts: rule.vocabularyScripts || [],
      notesRead: Number(rule.notesRead) || 0,
      notesOutsideVocabulary: Number(rule.notesOutsideVocabulary) || 0,
      notesWithNoLetters: Number(rule.notesWithNoLetters) || 0,
      outsideExamples: rule.outsideExamples || [],
      markerCount: Number(rule.markerCount) || 0,
      markersThatFiredOnNothing: rule.markersThatFiredOnNothing || [],
      rowsFiredByShapes: Number(rule.rowsFiredByShapes) || 0,
      rowsFiredByMarkers: Number(rule.rowsFiredByMarkers) || 0,
      because: rule.because,
    },
    markerDeclaration: declaration
      ? {
          state: declaration.state,
          file: declaration.file,
          note: declaration.note || null,
          markers: (declaration.markers || []).map((marker) => ({ phrase: marker.phrase, because: marker.because || null })),
          problems: declaration.problems || [],
        }
      : { state: "not-read", file: null, note: null, markers: [], problems: [] },
    skippedByBound: skipped.map((item) => ({ term: item.term, flaggingVolume: item.flaggingVolume, because: item.because })),
    decisions,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
    return { written: true, file, error: null };
  } catch (err) {
    return { written: false, file, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * The human-readable log of one settlement pass.
 *
 * Every term is named, including the ones the bound refused to pay for and the ones the revision door
 * refused. A log that only prints the decisions that worked is a log that hides the decisions that
 * did not, and the account owner is the one who has to be able to argue with the bound.
 *
 * @param {Object} header - `{settled, limit, agendaCount, chainCount, forwardCount, skipped, textRule, declaration}`
 * @param {Array<Object>} decisions - Every entry, newly decided and carried over.
 * @returns {string} The file content, ending in a newline.
 */
function renderSettlementLog(header, decisions) {
  const rule = header.textRule || NOTE_RULE_NOT_REPORTED;
  const out = [
    "# Glossary Settlement",
    "",
    `_Written by the settlement pass itself: which terms the settled record said were worth asking about, ` +
      `what the reading call answered, what the revision door accepted, and what the bound refused to pay for. ` +
      `No agent writes this file._`,
    "",
    `_Asked of the settled record: ${header.settled.folder}/${REFERENCE_STORE_FILE_NAME} ` +
      `(volume ${header.settled.volume}). Agenda: ${header.agendaCount} term(s) ` +
      `(${header.chainCount} already revised, ${header.forwardCount} whose own note points forward). ` +
      `The bound is ${header.limit} terms per run — a constant in \`glossary/settlement/agenda.js\`, not a setting._`,
    "",
    "## What the note half of the agenda was able to read",
    "",
    `_State: **${rule.state}**. The shipped vocabulary is written in ` +
      `${rule.vocabularyScripts.length ? rule.vocabularyScripts.join(", ") : "(nothing reported)"}; ` +
      `it read ${rule.notesRead} note(s), ${rule.notesOutsideVocabulary} of them written in a script that ` +
      `vocabulary is not written in, and ${rule.notesWithNoLetters} held no letters at all. ` +
      `${rule.rowsFiredByShapes} row(s) fired a shipped shape and ${rule.rowsFiredByMarkers} fired a declared marker._`,
    "",
    `_${rule.because}_`,
    "",
  ];

  if (rule.outsideExamples.length) {
    out.push(`Notes the shipped vocabulary cannot read, examples: ${rule.outsideExamples.map((e) => `"${e.term}" (${e.script})`).join(", ")}.`, "");
  }
  if (rule.markerCount > 0) {
    out.push(`${rule.markerCount} marker(s) this series declared were matched as literal text over every note.`, "");
    if (rule.markersThatFiredOnNothing.length) {
      out.push(
        `Declared markers that fired on 0 notes: ${rule.markersThatFiredOnNothing.map((phrase) => `"${phrase}"`).join(", ")}. ` +
          `A declared phrase that matches nothing this record says is a vocabulary gap, not a clean bill of health.`,
        ""
      );
    }
  }
  const declaration = header.declaration || null;
  if (declaration) {
    if (declaration.state === "declared") {
      out.push(`Declared by ${declaration.file}: ${declaration.markers.map((m) => `"${m.phrase}"`).join(", ")}.`, "");
    } else if (declaration.state === "empty") {
      out.push(`This series' plan of record declares no markers of its own — ${declaration.note}`, "");
    } else if (declaration.state === "malformed") {
      out.push(
        `**${declaration.file} has a \`settlement\` block that cannot be read**, so the note half ran on the ` +
          `shipped vocabulary alone:` +
          declaration.problems.map((p) => `\n- ${p}`).join(""),
        ""
      );
    } else if (declaration.state === "absent") {
      out.push(
        "No `settlement` block in this series' plan of record, so the note half ran on the shipped vocabulary " +
          "alone. That vocabulary covers the scripts its own phrases are written in and nothing else.",
        ""
      );
    }
  }

  const asked = decisions.filter((d) => d.asked);
  const carried = decisions.filter((d) => d.carriedOver === true);
  const open = decisions.filter((d) => !decisionClosesQuestion(d));

  out.push(`## Decided in this pass (${asked.length})`, "");
  if (asked.length === 0) {
    out.push("_Nothing new. Every term on the agenda had already been answered by an earlier pass, so this pass made no model call._", "");
  }
  for (const d of asked) {
    out.push(`### ${d.term}${d.section ? ` — ${d.section}` : ""}`);
    out.push(`- why asked: ${d.because}`);
    out.push(`- the record printed: "${d.currentRendering}" (owned by volume ${d.flaggingVolume})`);
    out.push(`- answer: **${d.decision}**${d.chosenRendering ? ` → "${d.chosenRendering}"` : ""}`);
    if (d.reason) out.push(`- the answer's reason: ${d.reason}`);
    if (d.quote) out.push(`- the line it quoted: "${d.quote}"`);
    if (d.filed) {
      out.push(`- filed: yes — volume ${d.flaggingVolume}'s revision door accepted it, replacing "${d.replacedRendering}".`);
      if (d.propagatedTo.length) out.push(`- carried into: ${d.propagatedTo.map((v) => `volume ${v}`).join(", ")} (the store's own top-up door, which adds rows and edits none).`);
      out.push(`- settled: ${d.settled ? "yes — the settled record now prints this rendering" : "NO — the settled record still prints something else, and that is named rather than hidden"}.`);
      if (d.settled) out.push(`- next pass: this answer closes **both** identities — the rendering it was asked about and the one the record now prints — so the next pass pays 0 for this term.`);
    } else if (decisionClosesQuestion(d)) {
      out.push(`- filed: NO — \`${d.refusalRule}\`: ${d.refusalBecause}`);
      out.push(`  The term keeps the rendering the record already had. The question **was answered**, so the next pass does not pay for the same refusal.`);
    } else {
      out.push(`- filed: NO — \`${d.refusalRule}\`: ${d.refusalBecause}`);
      out.push(`  **This question is not answered.** The term keeps the rendering the record already had, and the next pass asks it again: a reading call that never brought back a decision is a failed read, not a decision (AGENTS.md gotcha 138).`);
    }
    out.push("");
  }

  out.push(`## Already answered by an earlier pass (${carried.length})`, "");
  if (carried.length === 0) {
    out.push("_Nothing carried: this is the first settlement pass over this record._", "");
  } else {
    out.push(`_These identities are unchanged since they were answered, so no model call was paid for them._`, "");
    for (const d of carried) {
      out.push(
        `- "${d.term}" — "${d.currentRendering}" (volume ${d.flaggingVolume}) — decided ${d.decision}` +
          `${d.chosenRendering && d.chosenRendering !== d.currentRendering ? ` → "${d.chosenRendering}"` : ""} on ${d.decidedAt}`
      );
    }
    out.push("");
  }

  out.push(`## Still open — asked again by the next pass (${open.length})`, "");
  if (open.length === 0) {
    out.push("_Nothing: every question this pass put to the record was answered._", "");
  } else {
    out.push(`_Recorded so the cost is visible, and asked again next run. A question nobody answered is not a question that needed no asking._`, "");
    for (const d of open) {
      const prefix = d.asked ? "" : "never asked — ";
      out.push(`- "${d.term}" (volume ${d.flaggingVolume}) — ${prefix}\`${d.refusalRule}\`: ${d.refusalBecause}`);
    }
    out.push("");
  }

  out.push(`## Cut by the bound (${header.skipped.length})`, "");
  if (header.skipped.length === 0) {
    out.push("_None: this series' agenda fit inside the bound._", "");
  } else {
    out.push(`_Candidates, but the run had already spent its ${header.limit} terms. Named here rather than left out._`, "");
    for (const item of header.skipped) out.push(`- "${item.term}" (volume ${item.flaggingVolume}) — ${item.because}`);
    out.push("");
  }

  return out.join("\n").replace(/\n+$/, "") + "\n";
}

module.exports = {
  SETTLEMENT_JSON_FILE,
  SETTLEMENT_MD_FILE,
  SETTLEMENT_RECORD_SCHEMA,
  UNANSWERED_DECISIONS,
  NOTE_RULE_NOT_REPORTED,
  settlementRecordPaths,
  decisionKey,
  decisionClosesQuestion,
  decisionIdentityKeys,
  readSettlementDecisions,
  recordedDecision,
  buildDecision,
  writeSettlementRecord,
  renderSettlementLog,
};
