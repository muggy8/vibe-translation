/**
 * utils/reference-store/validation/report-axes.js — the report's register answer: which questions this
 * record can answer, and how much of itself it holds that answers none of them.
 *
 * Plan 06 slice 5 required both halves to be visible in the record's own audit output rather than in a
 * code comment, because the two facts are easy to lose silently:
 *
 *   - a claim that names a declared question is answerable **by that question**;
 *   - a claim that names none is answerable only by its aspect, and four of the extraction's seven kinds
 *     share the one aspect `register` (§2.3), so for those claims "how formal" and "which words" are one
 *     undifferentiated pile.
 *
 * The second half is the majority of every real volume in this corpus today, and the report says so with
 * numbers. It is not written as a finding: the two questions that would make it one are plan 06 §4.3
 * guards 3 and 4, each of which needs a new kind in the level table, and that is a slice of its own
 * (§10.12). A report line is the honest shape for a fact the pipeline is correct to admit.
 *
 * @module utils/reference-store/validation/report-axes
 */

require("../../../types"); // JSDoc type definitions

/**
 * The two rows this answer contributes to the report's "What was checked" table.
 *
 * Printed whenever the audit computed an answer (`axes` present), including when the answer is zero — a
 * report that goes silent at zero is how "the record can answer nothing" becomes invisible.
 *
 * @param {Object|null} axes - `registerAxisInventory`'s answer.
 * @returns {string[]} Zero, or two Markdown table rows.
 */
function axisAnswerTableRows(axes) {
  if (!axes || !axes.ok) return [];
  const answered = axes.byAxis || [];
  const answering = Number(axes.claimsAnswering || 0);
  const none = Number(axes.claimsAnsweringNone || 0);
  const declaredCount = Number(axes.axesDeclared || 0);

  let answeringCell;
  if (answered.length) {
    answeringCell =
      `**${answering}** — across ${answered.length} question(s): ` +
      answered.map((entry) => `\`${entry.axis}\` (${entry.claims})`).join(", ") +
      (axes.truncatedAxes ? `; ${axes.truncatedAxes} more question(s) not listed here` : "");
  } else if (answering === 0 && declaredCount === 0) {
    answeringCell =
      `**0** — this series declares **no** register questions, so no claim in this record can answer one ` +
      `(see the section below)`;
  } else {
    answeringCell =
      `**0** — this series declares ${declaredCount} question(s) and no claim in this record answers any of them`;
  }
  const rows = [`| claims that answer a declared register question | ${answeringCell} |`];

  const collapse = axes.collapse || {};
  const collapsedNone = Number(collapse.claimsAnsweringNone || 0);
  const labels = Array.isArray(collapse.labels) ? collapse.labels : [];
  let noneCell;
  if (none === 0) {
    noneCell = "none — every character-voice claim in this record names the question it answers";
  } else {
    noneCell =
      `**${none}**` +
      (collapsedNone
        ? ` — ${collapsedNone} of them sit on the one \`${collapse.aspect}\` aspect the extraction's ` +
          `${Number(collapse.kindsCollapsed || 0)} kinds collapse into` +
          (labels.length ? ` (${labels.map((l) => `${l.label} ×${l.claims}`).join(", ")})` : "")
        : "");
  }
  rows.push(`| claims that answer no declared question | ${noneCell} |`);
  return rows;
}

/**
 * The narrative section: the questions this record can answer, the claims that answer none, and why the
 * aspect names were not simply changed.
 *
 * @param {Object|null} axes - `registerAxisInventory`'s answer.
 * @returns {string[]} Markdown lines, empty when there is no answer to print.
 */
function axisAnswerSection(axes) {
  if (!axes || !axes.ok) return [];
  const out = ["## Which register questions this record can answer", ""];
  const answered = axes.byAxis || [];
  const declared = axes.declaredAxes || [];
  const collapse = axes.collapse || {};
  const total = Number(axes.claimsTotal || 0);

  out.push(
    "Asked of this series' own plan of record. The pipeline holds no list of register questions of its own, " +
    "in any language, so what this record can answer is exactly what the intake declared — and what it " +
    "cannot answer is the part the extraction was never asked."
  );
  out.push("");

  if (declared.length === 0) {
    const why =
      axes.declarationState === "absent"
        ? `its plan of record (\`translation-target.json\`) has no \`register\` block at all`
        : axes.declarationState === "empty"
          ? `the intake declared none and said why: "${axes.declarationNote || "no note"}"`
          : axes.declarationState === "malformed"
            ? "the block the intake wrote is malformed, so nothing can be checked against it"
            : `the store handle carries no declaration (${axes.declarationState})`;
    out.push(
      `**This series declares no register questions** — ${why}. So **0** of the ${total} character-voice ` +
      `claim(s) in this record answers a declared question, and none of them can: the filing gate refuses a ` +
      `claim that names a question this series never declared, and no door is allowed to guess one.`
    );
    out.push("");
  } else if (answered.length === 0) {
    out.push(
      `This series declares **${declared.length}** question(s) — ${declared.map((a) => `\`${a.id}\``).join(", ")} — ` +
      `and **no claim in this record answers any of them.** Every one of the ${total} character-voice claim(s) ` +
      `was filed without naming a question, which is what a claim looks like when the reading pass was not ` +
      `asked one. ${declared.length} declared question(s) answered zero times in this volume is the signal ` +
      `plan 06 §4.3 guard 3 exists to report; that guard is not built, and the reason it is not is written ` +
      `in §10.12 — it needs a new kind in the finding level table.`
    );
    out.push("");
  } else {
    out.push("| question | claims | characters | answers this record gives |");
    out.push("|---|---|---|---|");
    for (const entry of answered) {
      const values = (entry.valuesAnswered || []).map((v) => `\`${v.value}\` (${v.claims})`).join(", ");
      out.push(
        `| \`${entry.axis}\`${entry.asks ? ` — ${entry.asks}` : ""}${entry.declared ? "" : " **(not declared by this series)"} ` +
        `| ${entry.claims} | ${entry.characters} | ${values || "no value recorded"} |`
      );
    }
    out.push("");
    if (axes.truncatedAxes) {
      out.push(`(${axes.truncatedAxes} further question(s) answered in this record are not listed here.)`);
      out.push("");
    }
    if (axes.undeclaredAxes && axes.undeclaredAxes.length) {
      out.push(
        `**${axes.undeclaredAxes.length} axis/axes in this record are not declared by this series** — ` +
        axes.undeclaredAxes.map((entry) => `\`${entry.axis}\` (${entry.claims} claim(s))`).join(", ") +
        ". A claim cannot be filed against an undeclared axis, so these rows were filed when the series' declaration " +
        "was different from the one it has now; they are kept, and they are named."
      );
      out.push("");
    }
  }

  const none = Number(axes.claimsAnsweringNone || 0);
  const collapsedNone = Number(collapse.claimsAnsweringNone || 0);
  const labels = Array.isArray(collapse.labels) ? collapse.labels : [];
  if (none > 0) {
    out.push(
      `**${none} claim(s) in this record answer no declared question.**` +
      ((axes.axislessByAspect || []).length
        ? ` They sit on these aspects: ${(axes.axislessByAspect || [])
            .map((entry) => `\`${entry.aspect}\` (${entry.claims})`)
            .join(", ")}.${axes.truncatedAspects ? ` (${axes.truncatedAspects} more aspect(s) not listed.)` : ""}`
        : "")
    );
    if (collapsedNone > 0) {
      out.push(
        `${collapsedNone} of them sit on the one \`${collapse.aspect}\` aspect, which is where the extraction's ` +
        `${Number(collapse.kindsCollapsed || 0)} kinds — ${(collapse.kinds || []).map((k) => `\`${k}\``).join(", ")} — ` +
        `all land (plan 06 §2.3). For those claims the extractor's own distinction survives only in the bullet's ` +
        `label${labels.length ? ` (${labels.map((l) => `${l.label} ×${l.claims}`).join(", ")})` : ""}, so a query ` +
        `cannot tell "how formal is this character" apart from "which words does this character use" for them.`
      );
    }
    out.push("");
  }

  out.push(
    "**Why the aspect names were not simply changed.** The rows carrying them are published, and a sealed row is " +
    "never edited, moved or re-labelled — the rule this whole store is built on. So the distinction rides on the "
    + "axis a claim names (\`facts.axis\` / \`facts.axis_value\`, checked at filing against the series' own declaration), " +
    "the coarse aspect stays exactly where it is for a claim that names none, and a claim already filed without an " +
    "axis keeps no axis: the new answer is a new row beside the old one, never an edit of it."
  );
  if (axes.candidateRows) {
    out.push("");
    out.push(
      `(${axes.candidateRows} extraction candidate row(s) about this volume are kept out of every number above — ` +
      "they are the extractor's own copies, not published content, and the renderers and the coverage rule exclude " +
      "them for the same reason.)"
    );
  }
  out.push("");
  return out;
}

module.exports = {
  axisAnswerTableRows,
  axisAnswerSection,
};
