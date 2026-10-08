/**
 * Targeted correction: fix the passage the findings quote instead of translating
 * the whole chapter again.
 *
 * The trust boundary is paragraph-count equality (gotcha 47) — the only honest
 * source-to-draft mapping available is "they line up one-to-one". When the mapping
 * cannot be trusted the shortcut is REFUSED and the whole-chapter pass runs; a wrong
 * mapping deletes good text and inserts text that does not belong.
 *
 * Part of the translate.js layer (split out of the original single file).
 */

/**
 * Split a text into paragraph blocks, losslessly (blocks joined by "\n\n"
 * reproduce the original apart from blank-line normalization).
 *
 * @param {string} text
 * @returns {string[]}
 */
function paragraphBlocks(text) {
  return (text || "")
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}


/**
 * Split a findings block into its individual finding items.
 *
 * The graders write a numbered list (or FINDING blocks); each item carries its
 * own `Source: "…"` quote. Splitting them is what makes a targeted repair
 * possible: a finding about paragraph 7 must not be injected into the pass that
 * is rewriting paragraph 2.
 *
 * @param {string} findingsText - The findings text stored in the sidecar.
 * @returns {Array<{text: string, quote: string}>}
 */
function parseFindingItems(findingsText) {
  const text = (findingsText || "").trim();
  if (!text) return [];
  const items = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (/^\s*(?:\d+\.\s|\[(?:HIGH|MEDIUM|LOW)\]|FINDING\b)/i.test(line)) {
      if (current) items.push(current);
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) items.push(current);
  return items
    .map((lines) => {
      const itemText = lines.join("\n").trim();
      const m = itemText.match(/Source:\s*"([^"]+)"/i);
      return { text: itemText, quote: m ? m[1] : "" };
    })
    .filter((item) => item.text && !/^##\s*Findings$/i.test(item.text));
}


/**
 * Locate a verbatim quote inside a list of source paragraphs.
 *
 * All whitespace is removed on both sides (a quote copied out of a findings list
 * rarely keeps the source's line breaks, and source-language text has no word
 * spaces), and the search runs over the joined paragraphs so a quote that spans
 * two of them still resolves — to BOTH of them.
 *
 * @param {string[]} sourceBlocks - Source paragraphs in order.
 * @param {string} quote - The verbatim quote to find.
 * @returns {{start: number, end: number}|null} The paragraph range, or null when the quote is not in the source.
 */
function locateQuoteRange(sourceBlocks, quote) {
  // Whitespace is removed on BOTH sides. A quote copied out of a findings list
  // rarely keeps the source's line breaks, and source-language text (Japanese,
  // Chinese) has no word spaces at all — joining paragraphs with a space would
  // make a quote that crosses a paragraph boundary impossible to find.
  const squash = (t) => (t || "").replace(/\s+/g, "");
  const q = squash(quote);
  if (!q) return null;
  let joined = "";
  const ranges = [];
  for (const b of sourceBlocks) {
    const start = joined.length;
    joined += squash(b);
    ranges.push({ start, end: joined.length });
  }
  const at = joined.indexOf(q);
  if (at < 0) return null;
  const stop = at + q.length;
  const hit = ranges.findIndex((r) => r.end > at && r.start < stop);
  if (hit < 0) return null;
  let last = hit;
  while (last + 1 < ranges.length && ranges[last + 1].start < stop) last++;
  return { start: hit, end: last };
}


/**
 * Decide whether a chapter can be repaired by re-translating only the passages
 * its verification findings point at — and which passages those are.
 *
 * Today a chapter with ONE bad sentence is translated again from scratch: a
 * whole chapter of generation to fix a paragraph, with a fresh chance to break
 * something that was already right. The findings quote short source spans, so
 * the spans can be located, and the corrected text stitched back into the draft.
 *
 * The plan is refused (and the caller runs the whole-chapter pass) whenever the
 * mapping is not trustworthy:
 *   - the source and the draft do not have the same number of paragraphs
 *     (the paragraph-preserving translation contract is broken, so there is no
 *     honest way to say which draft paragraph a source quote belongs to);
 *   - a finding quotes source text that cannot be found;
 *   - the affected span covers the chapter (then a fresh pass is both cheaper
 *     and safer);
 *   - an affected draft paragraph is not a plausible rendering of its source
 *     paragraph (the strongest sign that the alignment is wrong).
 *
 * @param {{sourceText: string, draftText: string, findingsText: string, maxCoverage?: number}} p
 * @returns {{usable: boolean, reason: string, blocks: Array<{start: number, end: number, quotes: string[], findings: string[]}>}}
 */
function planTargetedRepair({ sourceText, draftText, findingsText, maxCoverage = 0.5 }) {
  const none = { usable: false, reason: "", blocks: [] };
  const sourceBlocks = paragraphBlocks(sourceText);
  const draftBlocks = paragraphBlocks(draftText);
  if (sourceBlocks.length < 2 || draftBlocks.length < 2) {
    return { ...none, reason: "the chapter has too few paragraphs for a passage-level repair" };
  }
  if (sourceBlocks.length !== draftBlocks.length) {
    return {
      ...none,
      reason:
        `the source has ${sourceBlocks.length} paragraphs and the draft has ${draftBlocks.length} — ` +
        `they cannot be aligned, so a passage-level repair would guess which paragraph to replace`,
    };
  }
  const items = parseFindingItems(findingsText);
  if (items.length === 0) return { ...none, reason: "the findings name no individual problem to fix" };

  const located = [];
  const chapterWide = [];
  for (const item of items) {
    const range = item.quote ? locateQuoteRange(sourceBlocks, item.quote) : null;
    if (range) located.push({ ...range, quote: item.quote, finding: item.text });
    else chapterWide.push(item);
  }
  if (located.length === 0) {
    return {
      ...none,
      reason: "no finding quotes a span that can be located in the source (a structural finding needs the whole chapter)",
    };
  }

  // Merge nearby spans so one call repairs one passage instead of one sentence.
  const merged = [];
  for (const l of [...located].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && l.start - last.end <= 2) {
      last.end = Math.max(last.end, l.end);
      last.quotes.push(l.quote);
      last.findings.push(l.finding);
    } else {
      merged.push({ start: l.start, end: l.end, quotes: [l.quote], findings: [l.finding] });
    }
  }
  const affected = merged.reduce((n, b) => n + (b.end - b.start + 1), 0);
  if (affected >= sourceBlocks.length) {
    return { ...none, reason: "every paragraph is affected — a whole-chapter pass is the cheaper and safer rewrite" };
  }
  if (affected / sourceBlocks.length > maxCoverage) {
    return {
      ...none,
      reason:
        `${affected} of ${sourceBlocks.length} paragraphs are affected ` +
        `(over ${Math.round(maxCoverage * 100)}% of the chapter) — not worth stitching`,
    };
  }
  for (const b of merged) {
    const srcLen = sourceBlocks.slice(b.start, b.end + 1).join(" ").length;
    const draftLen = draftBlocks.slice(b.start, b.end + 1).join(" ").length;
    const ratio = draftLen / Math.max(1, srcLen);
    if (ratio < 0.25 || ratio > 5) {
      return {
        ...none,
        reason:
          `draft paragraphs ${b.start + 1}–${b.end + 1} do not look like a translation of the source span ` +
          `they would be swapped for (length ratio ${ratio.toFixed(2)})`,
      };
    }
  }
  // A finding with no locatable span is chapter-wide: it goes to every passage
  // pass, because dropping it would silently drop a real problem.
  for (const b of merged) {
    b.findings.push(...chapterWide.map((i) => i.text));
  }
  return {
    usable: true,
    reason: `${merged.length} passage(s), ${affected}/${sourceBlocks.length} paragraphs`,
    blocks: merged,
  };
}


/**
 * Stitch corrected passages back into the draft: untouched paragraphs are kept
 * byte-for-byte, so a repair cannot quietly rewrite the rest of the chapter.
 *
 * @param {string[]} draftBlocks
 * @param {Array<{start: number, end: number}>} blocks - In ascending order, non-overlapping.
 * @param {string[]} replacements - One corrected text per block.
 * @returns {string} The stitched draft.
 */
function stitchParagraphs(draftBlocks, blocks, replacements) {
  const out = [];
  let cursor = 0;
  for (const [i, b] of blocks.entries()) {
    for (; cursor < b.start; cursor++) out.push(draftBlocks[cursor]);
    const text = (replacements[i] || "").trim();
    if (!text) throw new Error(`stitchParagraphs: no corrected text for passage ${b.start + 1}–${b.end + 1}`);
    out.push(text);
    cursor = b.end + 1;
  }
  for (; cursor < draftBlocks.length; cursor++) out.push(draftBlocks[cursor]);
  return out.join("\n\n");
}


/**
 * The "you are correcting a passage, not translating a chapter" task line.
 *
 * The surrounding translated text is given so names, tense, register and voice
 * stay identical at the seams — without it the model writes a fresh opening and
 * the stitched chapter reads as two different translations welded together.
 *
 * @param {{before?: string, after?: string, blockNumber: number, blockCount: number}} p
 * @returns {string}
 */
function buildPassageScopeLine({ before = "", after = "", blockNumber, blockCount }) {
  const parts = [
    `本次只修正整章中的第 ${blockNumber} 个片段（共 ${blockCount} 个），该章节的其余部分已有译文。` +
      `只翻译【源文】里的内容，不要翻译其它内容。`,
  ];
  if (before.trim()) {
    parts.push(
      `你的译文紧接在以下已有译文之后 —— 人名、时态、语域与语气必须与其完全一致，且不得重复它：\n   …${before.trim()}`
    );
  }
  if (after.trim()) {
    parts.push(
      `你的译文之后紧跟着以下已有译文 —— 人名、时态、语域与语气必须与其完全一致，且不得翻译它：\n   ${after.trim()}…`
    );
  }
  return parts.join("\n");
}

// ─── Volume-level consistency pass (the cross-chapter blind spot) ───────────


module.exports = {
  paragraphBlocks,
  parseFindingItems,
  locateQuoteRange,
  planTargetedRepair,
  stitchParagraphs,
  buildPassageScopeLine,
};
