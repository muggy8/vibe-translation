/**
 * utils/disputes.js — the glossary disputes queue.
 *
 * The pipeline had one direction for terminology: the glossary is law, and the
 * translation is graded against it. But the check that grades the translation is
 * a model reading the SOURCE, and sometimes what it finds is that the glossary
 * is wrong. That observation used to die in a report: the verifier wrote "the
 * glossary entry appears wrong", the retranslate pass was still ordered to obey
 * the wrong entry, the next verify round complained again, and the loop
 * oscillated until the round cap ran out — with the glossary never told.
 *
 * This module gives that observation a place to live:
 *
 *   verify-translate  →  disputes recorded per chapter
 * (translation-verification.json)
 *        ↓
 *   series root  →  glossary-disputes.json + glossary-disputes.md
 *        ↓
 *   glossary task  →  reads them as an input and records the decision
 *   translation stage  →  a disputed term is still used as given (the fix happens
 * in the glossary, not by the translator improvising a third rendering), but the
 * prompt SAYS it is disputed, so the translator, the verifier and the report all
 * agree about what is provisional.
 *
 * No AI here: parsing, aggregating, and writing. The judgment stays with the
 * verifier that produced the dispute and the glossary pass that resolves it.
 */

const fs = require("fs").promises;
const path = require("path");

/** Series-root artifacts (the same place `consistency-report.md` lives). */
const DISPUTES_FILE = "glossary-disputes.json";
const DISPUTES_REPORT = "glossary-disputes.md";

/**
 * Parse the `GLOSSARY DISPUTE:` blocks out of a verifier's reply.
 *
 * The contract is in system-prompts/verify-translate.md. A block with no term is
 * ignored (there is nothing to reconcile); a block missing its evidence is kept
 * but flagged `unsupported`, because a dispute the glossary pass cannot check
 * against the source is a complaint, not a correction.
 *
 * @param {string} raw - The verifier's full reply.
 * @returns {Array<{term: string, canonical: string, proposed: string, sourceQuote: string, translationQuote: string, unsupported: boolean}>}
 */
function parseGlossaryDisputes(raw) {
  const text = (raw || "").trim();
  if (!text || !/GLOSSARY DISPUTE\s*:/i.test(text)) return [];
  const disputes = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    if (current.term) {
      disputes.push({
        ...current,
        unsupported: !current.sourceQuote || !current.canonical,
      });
    }
    current = null;
  };
  for (const line of text.split("\n")) {
    const head = line.match(/^\s*GLOSSARY DISPUTE\s*:\s*(.+?)\s*$/i);
    if (head) {
      flush();
      current = {
        term: head[1].trim(),
        canonical: "",
        proposed: "",
        sourceQuote: "",
        translationQuote: "",
      };
      continue;
    }
    if (!current) continue;
    const field = line.match(/^\s*(Canonical|Should be|Source|Translation)\s*:\s*"?(.*?)"?\s*$/i);
    if (!field) continue;
    const key = String(field[1]).toLowerCase();
    const value = field[2].trim().replace(/^"|"$/g, "");
    if (key === "canonical") current.canonical = value;
    else if (key === "should be") current.proposed = value;
    else if (key === "source") current.sourceQuote = value;
    else if (key === "translation") current.translationQuote = value;
  }
  flush();
  return disputes;
}

/**
 * Collect the disputes recorded in one volume's verification sidecar.
 *
 * @param {{chapters?: Object}} sidecar - The parsed translation-verification.json.
 * @param {string} volumeLabel - The installment number, stamped onto each dispute.
 * @returns {Array<Object>}
 */
function collectVolumeDisputes(sidecar, volumeLabel) {
  const out = [];
  const chapters = (sidecar && sidecar.chapters) || {};
  for (const [id, entry] of Object.entries(chapters)) {
    for (const d of Array.isArray(entry.disputes) ? entry.disputes : []) {
      if (!d || !d.term) continue;
      out.push({ ...d, volume: volumeLabel, chapter: id });
    }
  }
  return out;
}

/**
 * Merge disputes into the series-level queue, keyed by source term.
 *
 * The same term gets challenged in volume 3 and again in volume 11: that is one
 * dispute with two pieces of evidence, not two disputes. The strongest evidence
 * wins (a dispute that has a source quote outranks one that does not), and every
 * volume/chapter that raised it is kept, because the glossary pass needs to know
 * how widespread the problem is.
 *
 * @param {Array<Object>} existing - The queue already on disk.
 * @param {Array<Object>} incoming - The disputes from this run.
 * @returns {Array<Object>} The merged queue, sorted by how much evidence each has.
 */
function mergeDisputes(existing, incoming) {
  const byTerm = new Map();
  const add = (d) => {
    if (!d || !d.term) return;
    const key = d.term.trim().toLowerCase();
    if (!key) return;
    const prev = byTerm.get(key);
    if (!prev) {
      byTerm.set(key, {
        term: d.term.trim(),
        canonical: d.canonical || "",
        proposed: d.proposed || "",
        sourceQuote: d.sourceQuote || "",
        translationQuote: d.translationQuote || "",
        unsupported: d.unsupported === true,
        raised: [],
      });
      const rec = byTerm.get(key);
      if (d.volume) rec.raised.push({ volume: d.volume, chapter: d.chapter || "" });
      return;
    }
    // Keep the version that carries evidence.
    if (!prev.sourceQuote && d.sourceQuote) {
      prev.canonical = d.canonical || prev.canonical;
      prev.proposed = d.proposed || prev.proposed;
      prev.sourceQuote = d.sourceQuote;
      prev.translationQuote = d.translationQuote || prev.translationQuote;
      prev.unsupported = d.unsupported === true;
    }
    if (d.volume && !prev.raised.some((r) => r.volume === d.volume && r.chapter === (d.chapter || ""))) {
      prev.raised.push({ volume: d.volume, chapter: d.chapter || "" });
    }
  };
  for (const d of existing || []) add(d);
  for (const d of incoming || []) add(d);
  const merged = [...byTerm.values()];
  for (const d of merged) d.raised.sort((a, b) => String(a.volume).localeCompare(String(b.volume)));
  // The disputes a fixer should look at first: the ones with evidence, then the
  // ones raised most often.
  merged.sort((a, b) => {
    const evidence = Number(Boolean(b.sourceQuote)) - Number(Boolean(a.sourceQuote));
    if (evidence !== 0) return evidence;
    return b.raised.length - a.raised.length;
  });
  return merged;
}

/**
 * The terms currently in dispute (the translation stage's "this rendering is
 * provisional" set).
 *
 * @param {Array<Object>} disputes
 * @returns {Set<string>}
 */
function disputedTermSet(disputes) {
  const set = new Set();
  for (const d of disputes || []) {
    if (d && d.term) set.add(d.term);
  }
  return set;
}

/**
 * The human-readable queue.
 *
 * @param {Array<Object>} disputes
 * @param {{seriesName?: string}} [meta]
 * @returns {string}
 */
function renderDisputesMarkdown(disputes, meta = {}) {
  const lines = [];
  lines.push(`# Glossary Disputes${meta.seriesName ? ` — ${meta.seriesName}` : ""}`);
  lines.push("");
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(
    `**What this file is.** The translation verifier reads the source text, and sometimes what it ` +
      `finds is that the GLOSSARY is wrong rather than the translation. Those challenges are collected ` +
      `here so the glossary task can settle them. Until one is settled, the term is still used as the ` +
      `glossary says — the fix happens in the glossary, not by the translator improvising a third ` +
      `rendering.`
  );
  lines.push("");
  if (!disputes || disputes.length === 0) {
    lines.push(`No open disputes.`);
    lines.push("");
    return lines.join("\n");
  }
  lines.push(`## Open disputes (${disputes.length})`);
  lines.push("");
  lines.push("| Source term | Glossary says | Verifier says it should be | Evidence | Raised in |");
  lines.push("|---|---|---|---|---|");
  for (const d of disputes) {
    const evidence = d.sourceQuote ? `"${d.sourceQuote}"` : "**no source quote**";
    lines.push(
      `| ${d.term} | ${d.canonical || "—"} | ${d.proposed || "—"} | ${evidence} | ` +
        `${d.raised.map((r) => `${r.volume}${r.chapter ? ` ${r.chapter}` : ""}`).join(", ")} |`
    );
  }
  lines.push("");
  lines.push(`## What to do with them`);
  lines.push("");
  lines.push(`1. Re-run \`npx gulp glossary\`. The amend pass reads this file and must either correct `);
  lines.push(`   the entry or record why the canonical rendering stands (with the evidence it used).`);
  lines.push(`2. A dispute with **no source quote** is a complaint, not a correction — check it against `);
  lines.push(`   the source before changing anything.`);
  lines.push(`3. Settling a dispute changes the glossary, which invalidates the drafts that use the term `);
  lines.push(`   (per-chapter invalidation), so only those chapters are re-translated.`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Read the series dispute queue (fail-open: missing or corrupt → no disputes).
 *
 * @param {string} seriesDir
 * @returns {Promise<Array<Object>>}
 */
async function loadGlossaryDisputes(seriesDir) {
  if (!seriesDir) return [];
  try {
    const raw = await fs.readFile(path.join(seriesDir, DISPUTES_FILE), "utf8");
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.disputes) ? parsed.disputes : [];
    return list.map((d) => ({ ...d, raised: Array.isArray(d.raised) ? d.raised : [] }));
  } catch {
    return [];
  }
}

/**
 * Write the series dispute queue (JSON + the readable report).
 *
 * @param {string} seriesDir
 * @param {Array<Object>} disputes
 * @param {{seriesName?: string}} [meta]
 * @returns {Promise<{count: number}>}
 */
async function saveGlossaryDisputes(seriesDir, disputes, meta = {}) {
  const list = Array.isArray(disputes) ? disputes : [];
  await fs.writeFile(
    path.join(seriesDir, DISPUTES_FILE),
    JSON.stringify({ schema: 1, updatedAt: new Date().toISOString(), disputes: list }, null, 2) + "\n",
    "utf8"
  );
  await fs.writeFile(path.join(seriesDir, DISPUTES_REPORT), renderDisputesMarkdown(list, meta), "utf8");
  return { count: list.length };
}

module.exports = {
  DISPUTES_FILE,
  DISPUTES_REPORT,
  parseGlossaryDisputes,
  collectVolumeDisputes,
  mergeDisputes,
  disputedTermSet,
  renderDisputesMarkdown,
  loadGlossaryDisputes,
  saveGlossaryDisputes,
};
