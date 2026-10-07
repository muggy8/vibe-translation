/**
 * The rendering-variant scan — free, no model call.
 *
 * Every glossary term used in a volume is checked against the PUBLISHED text for
 * near-variants of its canonical rendering: a second rendering of the same source
 * term (HIGH), different spacing/hyphenation (MEDIUM), different capitalisation or
 * a plural alongside the singular (LOW). This is the most common drift class in a
 * long translation, and it is invisible to a per-chapter verifier, which never sees
 * the volume.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

const { isSpaceSeparated } = require("./qa");

/**
 * Find near-variants of the canonical renderings in a published volume.
 *
 * The most common drift class in a long translation is not a wrong word — it is
 * the SAME thing being written two ways: "Sora" and "sora", "Blacksteel" and
 * "Black steel", 鏡 rendered as "Mirror" in chapter 2 and "the Mirror system" in
 * chapter 7. A model-based verifier is a poor detector for this (it reads the
 * chapter, not the volume) and it is completely free to check deterministically,
 * so it runs on every volume with no token spent.
 *
 * What it reports:
 *   HIGH  — the glossary gives this source term two different renderings and the
 *           volume uses more than one of them (a real terminology conflict).
 *   MEDIUM — the canonical rendering appears in the volume in a differently
 *           hyphenated/spaced form ("Blacksteel" vs "Black steel").
 *   LOW   — the canonical rendering appears in a different case, or as a plural
 *           alongside the singular (often legitimate, so it is only reported).
 *
 * @param {{text: string, terms: Array<{term: string, rendering: string, section?: string}>, targetLanguage?: string}} p
 * @returns {Array<{term: string, canonical: string, variant: string, count: number, kind: string, severity: "HIGH"|"MEDIUM"|"LOW"}>}
 */
function findRenderingVariants({ text, terms = [], targetLanguage = "English" }) {
  const body = text || "";
  if (!body.trim() || terms.length === 0) return [];
  const wordBoundary = isSpaceSeparated(targetLanguage);
  const findings = [];

  // Escape a rendering for regex use, then allow the separators a human types
  // around a name ("Blacksteel" also appears as "Black steel" / "Black-steel").
  const escape = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const loosePattern = (rendering) => {
    // Separators are optional BETWEEN THE WORDS and also INSIDE a single word of
    // the canonical form: the drift this looks for is exactly a name written with
    // an extra space or hyphen ("Blacksteel" in the glossary, "Black steel" in
    // chapter 7). Only whitespace / hyphen / dash / underscore may appear, so a
    // match is still the same word. Each character is escaped on its own (an
    // escaped pair like `\.` must not be split in half).
    const SEP = "[\\s\\-_\\u2013\\u2014]*";
    const SEP1 = "[\\s\\-_\\u2013\\u2014]+";
    const words = rendering.trim().split(/\s+/).filter(Boolean);
    const core = words
      .map((word) => [...word].map(escape).join(SEP))
      .join(SEP1);
    return new RegExp(`(^|[^\\p{L}\\p{N}])(${core})(s)?(?=[^\\p{L}\\p{N}]|$)`, "giu");
  };

  // Two glossary rows for the same source term is a conflict the volume inherits.
  const bySource = new Map();
  for (const t of terms) {
    if (!t || !t.term || !t.rendering) continue;
    const key = t.term.trim();
    if (!bySource.has(key)) bySource.set(key, new Set());
    bySource.get(key).add(t.rendering.trim());
  }

  for (const [sourceTerm, renderings] of bySource) {
    if (renderings.size < 2) continue;
    const present = [];
    for (const rendering of renderings) {
      const re = new RegExp(escape(rendering), wordBoundary ? "giu" : "gi");
      const n = (body.match(re) || []).length;
      if (n > 0) present.push({ rendering, count: n });
    }
    if (present.length < 2) continue;
    findings.push({
      term: sourceTerm,
      canonical: [...renderings].join(" / "),
      variant: present.map((p) => `"${p.rendering}" ×${p.count}`).join(", "),
      count: present.reduce((n, p) => n + p.count, 0),
      kind: "the glossary gives this term two renderings and the volume uses both",
      severity: "HIGH",
    });
  }

  for (const t of terms) {
    const canonical = (t.rendering || "").trim();
    if (!canonical || canonical.length < 2) continue;
    const re = loosePattern(canonical);
    const forms = new Map();
    let m;
    while ((m = re.exec(body)) !== null) {
      // The captured form INCLUDES the trailing "s" when there was one — recording
      // "Mirrors" as "Mirror" (plural flag only) made it land in the same bucket
      // as the canonical form and vanish.
      const plural = m[3] === "s";
      const surface = m[2] + (plural ? "s" : "");
      forms.set(surface, { surface, plural, count: (forms.get(surface)?.count || 0) + 1 });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (forms.size === 0) continue;

    const canonicalLower = canonical.toLowerCase();
    // Keyed by the EXACT surface form (not a lowercased one) — collapsing case
    // first is what made a capitalisation drift invisible: "Sora" and "sora"
    // would land in the same bucket and look like the canonical form.
    const hasCanonicalSingular = forms.has(canonical);
    for (const [surface, entry] of forms) {
      const lower = surface.toLowerCase();
      if (surface === canonical) continue; // the canonical form itself
      // Spacing / hyphenation difference.
      const squash = (x) => x.toLowerCase().replace(/[\s\-_\u2013\u2014]+/g, "");
      if (!entry.plural && squash(surface) === squash(canonical) && lower !== canonicalLower) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering appears with different spacing or hyphenation",
          severity: "MEDIUM",
        });
        continue;
      }
      // Case difference (the same letters, a different capitalisation).
      if (!entry.plural && lower === canonicalLower) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering appears with different capitalisation",
          severity: "LOW",
        });
        continue;
      }
      // A plural alongside the singular form.
      if (entry.plural && hasCanonicalSingular) {
        findings.push({
          term: t.term,
          canonical,
          variant: surface,
          count: entry.count,
          kind: "the canonical rendering also appears as a plural (check it is the same referent)",
          severity: "LOW",
        });
      }
    }
  }

  // One finding per (term, variant) — the same drift seen in ten chapters is one
  // finding about the volume.
  const deduped = new Map();
  for (const f of findings) {
    const key = `${f.term}\u0000${f.variant.toLowerCase()}\u0000${f.kind}`;
    const prev = deduped.get(key);
    if (!prev) deduped.set(key, { ...f });
    else prev.count += f.count;
  }
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return [...deduped.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}


/**
 * Render the variant scan as a Markdown section (the verification report's
 * deterministic half — no model call produced it).
 *
 * @param {Array<Object>} findings
 * @returns {string}
 */
function renderVariantFindings(findings) {
  if (!findings || findings.length === 0) return "";
  const lines = [];
  lines.push("## Rendering variants (deterministic scan — no model call)");
  lines.push("");
  lines.push(
    "_Every glossary term used in this volume was scanned in the published text for near-variants of " +
      "its canonical rendering: a second rendering of the same source term, different spacing or " +
      "hyphenation, different capitalisation, or a plural alongside the singular._"
  );
  lines.push("");
  lines.push("| Severity | Source term | Canonical | Seen as | Count |");
  lines.push("|---|---|---|---|---|");
  for (const f of findings) {
    lines.push(`| ${f.severity} | ${f.term} | ${f.canonical} | ${f.variant} — ${f.kind} | ${f.count} |`);
  }
  lines.push("");
  return lines.join("\n");
}


module.exports = {
  findRenderingVariants,
  renderVariantFindings,
};
