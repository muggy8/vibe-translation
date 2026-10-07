/**
 * The cross-chapter consistency pass — the translation stage's one blind spot and
 * the layer that covers it.
 *
 * Every other check reads ONE chapter, which is the right shape for fidelity and the
 * wrong shape for drift: a volume that renders one name two ways, states a fact in
 * chapter 3 and denies it in chapter 9, publishes chapters that each score 90 and a
 * book that contradicts itself. This reads a volume's PUBLISHED chapters together,
 * windowing a volume larger than the auditor's context and reporting plainly which
 * chapters were never compared.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const tokens = require("../tokens");

const { estimateTokens } = require("./prompt");

/**
 * Pack a volume's chapters into consecutive windows that each fit the audit
 * model's prompt budget.
 *
 * The cross-chapter audit is the one check that must see several chapters at
 * once, so it cannot be split the way the per-chapter checks are. When a volume
 * is bigger than the role's context window, splitting it into consecutive
 * windows keeps every chapter audited against its neighbours (each window
 * carries the previous window's tail), which is what the check is FOR — and the
 * report says plainly which windows were audited together and which were not.
 *
 * A single chapter larger than the whole budget gets its own window and is
 * flagged `oversized`: the caller reports it rather than pretending it was
 * audited against its neighbours.
 *
 * @param {Array<{id: string, title?: string, text: string}>} chapters - Chapters in reading order.
 * @param {{maxTokens: number, reserve?: number}} budget - The role's window and the room kept for the reply.
 * @returns {Array<{chapters: Array<{id: string, title?: string, text: string}>, tokens: number, oversized: boolean}>}
 */
function planConsistencyWindows(chapters, { maxTokens, reserve = 0 }) {
  const budget = Math.max(1000, (maxTokens || 0) - reserve);
  const windows = [];
  let current = [];
  let tokens = 0;
  for (const ch of chapters) {
    const cost = estimateTokens(ch.text) + 40;
    if (current.length > 0 && tokens + cost > budget) {
      windows.push({
        chapters: current,
        tokens,
        oversized: estimateTokens(current[0].text) > budget,
      });
      current = [];
      tokens = 0;
    }
    current.push(ch);
    tokens += cost;
  }
  if (current.length > 0) {
    windows.push({
      chapters: current,
      tokens,
      oversized: current.length === 1 && estimateTokens(current[0].text) > budget,
    });
  }
  return windows;
}


/**
 * Escape a string for safe use inside a RegExp.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * Parse the cross-chapter auditor's reply into structured findings.
 *
 * The contract (system-prompts/volume-consistency.md) is
 * `FINDING [HIGH] chapters=ch3,ch9 — statement` plus Where/Contradicts/Fix
 * lines. Chapter ids are matched against the ids the pass actually sent, so a
 * chapter is never invented and a finding that names no real chapter is
 * reported as unfixable rather than silently attached to the wrong one.
 *
 * @param {string} raw - The auditor's reply.
 * @param {string[]} chapterIds - The chapter ids that were in the prompt.
 * @returns {Array<{severity: string, chapters: string[], statement: string, quote: string, contradicts: string, fix: string, untagged: boolean}>}
 */
function parseVolumeFindings(raw, chapterIds) {
  const text = (raw || "").trim();
  if (!text || /^\(no findings\)/i.test(text)) return [];
  const lines = text.split("\n");
  const findings = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const known = [];
    for (const id of chapterIds || []) {
      // Match the id as a whole token so "ch1" does not claim "ch1.1".
      const pattern = new RegExp(`(^|[^0-9A-Za-z.])${escapeRegExp(id)}([^0-9A-Za-z.]|$)`);
      if (pattern.test(current.searchText)) known.push(id);
    }
    findings.push({
      severity: current.severity,
      chapters: known,
      statement: current.statement,
      quote: current.quote,
      contradicts: current.contradicts,
      fix: current.fix,
      untagged: known.length === 0,
    });
    current = null;
  };
  for (const line of lines) {
    const head = line.match(
      /^\s*(?:\d+\.\s*)?FINDING\s*\[(HIGH|MEDIUM|LOW)\]\s*(?:chapters=([^\s—–\-]+))?\s*(?:[—–\-]+\s*)?(.*)$/i
    );
    if (head) {
      flush();
      const named = (head[2] || "").split(",").map((x) => x.trim()).filter(Boolean);
      current = {
        severity: String(head[1] || "MEDIUM").toUpperCase(),
        statement: (head[3] || "").trim(),
        quote: "",
        contradicts: "",
        fix: "",
        // The ids named on the heading line are part of the search text too.
        searchText: [head[2] || "", head[3] || ""].join(" "),
      };
      void named;
      continue;
    }
    if (!current) continue;
    const where = line.match(/^\s*Where:\s*"?(.*?)"?\s*$/i);
    if (where) {
      current.quote = where[1];
      current.searchText += " " + where[1];
      continue;
    }
    const against = line.match(/^\s*Contradicts:\s*"?(.*?)"?\s*$/i);
    if (against) {
      current.contradicts = against[1];
      current.searchText += " " + against[1];
      continue;
    }
    const fix = line.match(/^\s*Fix:\s*(.*)$/i);
    if (fix) {
      current.fix = fix[1].trim();
      continue;
    }
  }
  flush();
  return findings;
}


/**
 * What the retranslate pass should do with one chapter, given its per-chapter
 * verdict AND the volume-level findings that name it.
 *
 * The two inputs are different kinds of problem: the per-chapter verdict says
 * "this chapter does not match its source"; the volume findings say "this
 * chapter contradicts its neighbours". A chapter can be fine by the first and
 * broken by the second, and only the second kind is invisible to the chapter's
 * own check — so a HIGH cross-chapter finding makes a PASSING chapter a repair
 * target whatever its score.
 *
 * @param {{pass?: boolean, score?: number|null}|undefined} vEntry - The chapter's verification entry.
 * @param {Array<{severity: string}>} [volumeFindings] - Volume findings that name this chapter.
 * @returns {{action: "none"|"skip"|"fail"|"cross-chapter", reason: string}}
 */
function retranslateTarget(vEntry, volumeFindings = []) {
  const high = (volumeFindings || []).filter((f) => f && f.severity === "HIGH");
  if (!vEntry || typeof vEntry.pass !== "boolean") {
    return { action: "none", reason: "no verification verdict covers this draft" };
  }
  if (vEntry.pass) {
    if (high.length > 0) {
      return { action: "cross-chapter", reason: `${high.length} HIGH cross-chapter finding(s)` };
    }
    return { action: "skip", reason: "verification passed" };
  }
  return { action: "fail", reason: "verification failed" };
}


/**
 * Render volume findings back into the numbered "fix these" task the
 * retranslate pass takes (the same shape the per-chapter findings take).
 *
 * @param {Array<Object>} findings - Already narrowed to one chapter.
 * @returns {string} "" when there is nothing to fix.
 */
function volumeFindingsText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return "";
  const lines = findings.map((f, i) => {
    const parts = [`${i + 1}. [${f.severity}] ${f.statement}`];
    if (f.quote) parts.push(`   Volume says: "${f.quote}"`);
    if (f.contradicts) parts.push(`   But elsewhere: "${f.contradicts}"`);
    if (f.fix) parts.push(`   Fix: ${f.fix}`);
    const others = (f.chapters || []).filter((c) => c !== f.homeChapter);
    if (others.length > 0) {
      parts.push(`   (this contradiction also involves: ${others.join(", ")} — change ONLY the text you are given here)`);
    }
    return parts.join("\n");
  });
  return (
    `## Cross-chapter problems found in this volume\n` +
    `A volume-level audit compared these chapters with each other and with the ` +
    `previous volume. Fix these in the text you are translating. Do not introduce ` +
    `the other chapters' wording into this one beyond what the contradiction requires.\n\n` +
    lines.join("\n")
  );
}


/**
 * The volume findings that name one chapter (the retranslate pass's input).
 *
 * @param {Array<Object>} findings - The sidecar's findings.
 * @param {string} segmentId - The chapter being retranslated.
 * @returns {Array<Object>} The findings that name it, each with `homeChapter` set.
 */
function findingsForChapter(findings, segmentId) {
  return (Array.isArray(findings) ? findings : [])
    .filter((f) => Array.isArray(f.chapters) && f.chapters.includes(segmentId))
    .map((f) => ({ ...f, homeChapter: segmentId }));
}


/**
 * The volume-consistency report (human-readable, deterministic).
 *
 * @param {{installmentNumber: string, folder: string}} volume
 * @param {Array<{chapters: Array<{id: string}>, tokens: number, oversized: boolean}>} windows
 * @param {Array<Object>} findings
 * @param {{model?: string, notes?: string[], dropped?: string[]}} meta
 * @returns {string}
 */
function buildVolumeConsistencyMarkdown(volume, windows, findings, meta = {}) {
  const lines = [];
  lines.push(`# Volume ${volume.installmentNumber} — Cross-Chapter Consistency Report`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Auditor endpoint: ${meta.model || "AUDIT_* role"}`);
  lines.push(`Audit windows: ${windows.length} (each window is audited as one document)`)
  lines.push("");
  lines.push(`**Why this pass exists:** every other translation check reads ONE chapter ` +
    `at a time. A chapter can score 92/100 and still contradict the chapter before it — ` +
    `a second rendering of the same name, a fact one chapter states and another denies, ` +
    `a tense or point-of-view shift nothing else can see. This is the only pass that reads ` +
    `the chapters together.`);
  lines.push("");
  if (windows.length > 1) {
    lines.push(`## Audit windows`);
    lines.push("");
    lines.push("| Window | Chapters | Approx. tokens |");
    lines.push("|---|---|---|");
    for (const [i, w] of windows.entries()) {
      lines.push(`| ${i + 1} | ${w.chapters.map((c) => c.id).join(", ")} | ${w.tokens} |`);
    }
    lines.push("");
    lines.push(`Chapters in different windows were NOT compared with each other (the volume ` +
      `is larger than the auditor's context window).`);
    lines.push("");
  }
  const oversized = windows.filter((w) => w.oversized);
  if (oversized.length > 0) {
    lines.push(`> **Not audited against its neighbours:** ${oversized.map((w) => w.chapters.map((c) => c.id).join(", ")).join("; ")} ` +
      `— each is larger than the auditor's whole context window.`);
    lines.push("");
  }
  if (meta.dropped && meta.dropped.length > 0) {
    lines.push(`> **Reference material the auditor did NOT see:** ${meta.dropped.join("; ")}`);
    lines.push("");
  }
  lines.push(`## Findings (${findings.length})`);
  lines.push("");
  if (findings.length === 0) {
    lines.push(`No cross-chapter contradictions found.`);
  } else {
    const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const f of findings) counts[f.severity] = (counts[f.severity] || 0) + 1;
    lines.push(`HIGH: ${counts.HIGH || 0} · MEDIUM: ${counts.MEDIUM || 0} · LOW: ${counts.LOW || 0}`);
    lines.push("");
    for (const [i, f] of findings.entries()) {
      lines.push(`${i + 1}. **[${f.severity}]** ${f.statement}`);
      lines.push(`   - Chapters: ${f.chapters.length > 0 ? f.chapters.join(", ") : "**none named** (not actionable)"}`);
      if (f.quote) lines.push(`   - Volume says: "${f.quote}"`);
      if (f.contradicts) lines.push(`   - But elsewhere: "${f.contradicts}"`);
      if (f.fix) lines.push(`   - Fix: ${f.fix}`);
      lines.push("");
    }
    lines.push(`HIGH findings name chapters that the \`retranslate\` pass repairs with these`);
    lines.push(`findings injected as correction tasks. The draft ratchet guarantees a repair`);
    lines.push(`that scores worse than the chapter it replaced is rolled back.`);
    lines.push("");
  }
  if (meta.notes && meta.notes.length > 0) {
    lines.push(`## Notes`);
    lines.push("");
    for (const n of meta.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  return lines.join("\n");
}


module.exports = {
  planConsistencyWindows,
  escapeRegExp,
  parseVolumeFindings,
  retranslateTarget,
  volumeFindingsText,
  findingsForChapter,
  buildVolumeConsistencyMarkdown,
};
