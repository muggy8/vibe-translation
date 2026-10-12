/**
 * utils/reference-store/drafting.js — the query that asks whether a claim's prose is finished writing.
 *
 * ## Why this exists
 *
 * Volume 01's published reference carries this bullet, and it survived every check the pipeline runs:
 *
 *     - **Vocabulary register**: … / 「私の鞄の中に隠してある可能性が高いわ」 (wait, this is パンジー
 *       — need to recheck)
 *
 * and volume 02's carries a bullet that lists 日向葵's "new ending patterns" as
 *
 *     '〜じゃないとね', '〜しちゃう', '〜に決まってます', '〜Fantastic' — no, '〜Fantastic' not present.
 *     '〜Fantastic' not present. '〜Fantastic' not present. '〜Fantastic' not present.
 *
 * The string `Fantastic` appears **zero times** in volume 2's text. Both are the model's own drafting
 * work left in the published document: one is a note to itself about a job it had not finished, the
 * other is it arguing with itself mid-sentence. Neither is a claim about the book.
 *
 * ## Why the obvious rule was not shipped
 *
 * The tempting rule is "every quoted span in a claim must be findable in the volume's text". Measured
 * against the two real records (1,470 rows, 2,237 quoted spans in claim bodies) it reports **700
 * misses over 220 distinct spans** — because a voice reference legitimately quotes the shape of a
 * character's speech (`'〜かい？'`, `'〜かしら'`) which is a paraphrase of what the book says rather
 * than a copy of one line, and because apostrophes in English prose (`Joro's POV`) parse as quotes.
 * A detector that fires on 700 legitimate bullets is worse than no detector: it is the coverage guard's
 * wolf, reimported at twenty times the volume (AGENTS.md gotcha 99).
 *
 * ## What was shipped instead, and what it was measured against
 *
 * Two shapes, each narrow enough to name a *defect* rather than a style, each measured against the
 * real volumes 1 and 2 before being pinned:
 *
 *   1. **A drafting aside** — a bracketed span, outside the 「…」 quote marks, whose contents name a
 *      job the writer still has to do (`wait,`, `need to recheck`, `TODO`, `let me`, `要確認`). A gloss
 *      of a Japanese catchphrase — `'ま、いっか' (well, whatever)`, `'って言うか' (I mean / rather)`,
 *      `'まぁ別に' (well, not really)` — is analysis, and none of these markers appear in it. Measured:
 *      **1 distinct aside, 0 false positives** across both published references, both POV maps, both
 *      glossaries, every row of both records, and both extraction notebooks.
 *   2. **A claim arguing with itself** — the same quoted token repeated three or more times in one
 *      claim's body *and* a self-correction phrase in the same body. Either half alone is too loose:
 *      repetition alone fires on a legitimate list of five quoted expressions; a hedge alone fires on
 *      analysis. Together they fire on exactly one claim in this series. Measured: **2 rows (that claim
 *      and its carried copy), 0 false positives** across 1,470 rows.
 *
 * The intersection requirement is the whole design. Every marker list is a closed constant, because a
 * detector whose strictness the operator can dial is a detector that gets dialled down the first time
 * it names something the run would rather not read about.
 *
 * @module utils/reference-store/drafting
 */

const { finding } = require("../postmortem");

require("../../types"); // JSDoc type definitions

/** @typedef {import("../postmortem").PostMortemFinding} PostMortemFinding */

/**
 * A job the writer still has to do, in the writer's own voice.
 *
 * Deliberately narrow, and deliberately about *unfinished work* rather than about hedging. "well, not
 * really" is how a character dismisses something; "need to recheck" is how a writer admits it stopped
 * writing. Only the second one is a defect.
 *
 * @type {Array<{label: string, re: RegExp}>}
 */
const DRAFTING_JOB_MARKERS = Object.freeze([
  { label: "wait", re: /\bwait\b\s*[,;:]/i },
  { label: "wait", re: /\bwait\b\s*[—–-]/i },
  { label: "hold on", re: /\bhold on\b/i },
  { label: "recheck", re: /\bre-?check\b/i },
  { label: "double-check", re: /\bdouble[ -]check\b/i },
  { label: "unfinished job", re: /\bneed(?:s|ed)? to (?:re-?check|verify|confirm|check|fix|correct|remove|rewrite|update|add)\b/i },
  { label: "self-addressed task", re: /\bI (?:need|have|must|ought|will) to\b/i },
  { label: "let me", re: /\blet me\b/i },
  { label: "oops", re: /\boops\b/i },
  { label: "TODO", re: /\bTODO\b/ },
  { label: "FIXME", re: /\bFIXME\b/ },
  { label: "TBD", re: /\bTBD\b|\bTBC\b/ },
  { label: "to be verified", re: /\bto be (?:verified|confirmed|checked|revised|fixed)\b/i },
  { label: "unverified", re: /\bunverified\b|\bunconfirmed\b/i },
  { label: "要確認", re: /要確認|要検証|要修正|後で確認|後で直す|後で検証/ },
]);

/**
 * A writer correcting itself mid-sentence.
 *
 * @type {Array<{label: string, re: RegExp}>}
 */
const SELF_CORRECTION_MARKERS = Object.freeze([
  { label: "— no,", re: /\bno,\s/i },
  { label: "not present", re: /\bnot present\b/i },
  { label: "not in the text", re: /\bnot in the text\b/i },
  { label: "not used", re: /\bnot used\b/i },
  { label: "removing", re: /\bremoving (?:this|these|them|it)\b/i },
  { label: "let me correct", re: /\blet me correct\b/i },
  { label: "I need to", re: /\bI need to\b/i },
  { label: "correction:", re: /\bcorrection[:]/i },
  { label: "hallucination", re: /\bhallucinat/i },
  { label: "no longer present", re: /\bno longer (?:present|used)\b/i },
]);

/** Bracket pairs a writer's aside sits in. The 「」 of a quotation are not one of them. */
const ASIDE_PATTERNS = Object.freeze([
  { kind: "paren", re: /\(([^()「」『』]{2,240})\)/g },
  { kind: "fullwidth paren", re: /（([^（）「」『』]{2,240})）/g },
  { kind: "square", re: /\[([^\[\]「」『』]{2,240})\]/g },
]);

/** How many times one quoted token has to appear in one body before "repeated" means anything. */
const REPEATED_TOKEN_MIN = 3;

/** Quoted tokens in a claim's own prose: the shape a vocabulary or ending-pattern list uses. */
const TOKEN_PATTERNS = Object.freeze([/'([^'\n]{1,80})'/g, /“([^”\n]{1,80})”/g]);

/**
 * A label the extractor wrote for itself, sitting at the head of a claim.
 *
 * `NEW CHARACTER. Uses あんた as second-person pronoun for ジョーロ.` is a real observation about a real
 * character with the extraction pass's own scaffolding glued to the front of it. The label is not a claim
 * about the book: it is a note the extractor left in the field it was filling in, and it lands in a
 * document a translator is told to trust. The record already says the same thing properly — a character
 * new in this volume has `established_volume` = this volume — so the label adds nothing a reader needed.
 *
 * Measured against the corpus before it was pinned, in the same way the two shapes above were: **2,744
 * claim bodies** — every bullet of the two published character-voice references that exist (volume 01's
 * 227 and volume 02's 583), plus every row of both real reference records (574 rows and 1,360 rows) — and
 * the shape fires **9 times, on one distinct label (`NEW CHARACTER`), all of them in volume 02**: 3 in the
 * published file and 6 in the record, the adopted row and its extraction candidate for each of the three
 * characters. No legitimate claim body in either file opens with an all-caps Latin label.
 * The false-positive rate is 0 / 2,744, which is why this is a rule and not a guess.
 *
 * It is stripped, not refused, and that is a different answer from the two shapes above on purpose: an
 * unfinished sentence is a claim that does not assert anything, while this is a claim with a sticker on it.
 * Throwing away three real observations about three characters to remove three words nobody needed would
 * be the guard doing damage. The extraction's own copy of the claim keeps the label (see `rebuild.js`), so
 * the gap between what the extractor wrote and what the reference published stays queryable.
 *
 * @type {RegExp}
 */
const SCAFFOLDING_LABEL = /^([A-Z][A-Z0-9 &/+-]{2,30})[.:]\s*/;

/**
 * Whether a quoted token is a token and not a parsing artifact.
 *
 * `'…'` inside English prose splits on apostrophes — `僕's observation` yields `','`. A token has to
 * carry a letter or a number to count as something the claim is asserting.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isMeaningfulToken(token) {
  const t = String(token || "").trim();
  return t.length >= 2 && /[\p{L}\p{N}]/u.test(t);
}

/**
 * The quoted tokens in one piece of prose, with how often each appears.
 *
 * @param {string} text
 * @returns {Map<string, number>}
 */
function quotedTokenCounts(text) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const body = String(text || "");
  for (const re of TOKEN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const token = m[1].trim();
      if (!isMeaningfulToken(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Shape 1: a bracketed aside that names a job the writer still has to do.
 *
 * @param {string} text - One claim's prose, or one published bullet.
 * @returns {Array<{kind: "aside", span: string, marker: string, label: string}>}
 */
function draftingAsides(text) {
  /** @type {Array<{kind: "aside", span: string, marker: string, label: string}>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  const body = String(text || "");
  for (const { kind, re } of ASIDE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      const span = m[1].trim();
      for (const { label, re: marker } of DRAFTING_JOB_MARKERS) {
        const hit = span.match(marker);
        if (!hit) continue;
        const key = `${kind}|${span}`;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ kind: "aside", span, marker: hit[0], label });
        break;
      }
    }
  }
  return out;
}

/**
 * Shape 2: a claim arguing with itself.
 *
 * Both halves are required, and that is the calibration. Repetition alone fires on a legitimate list
 * of quoted expressions; a self-correction phrase alone fires on analysis that weighs alternatives.
 * Together they fire on a claim that quotes the same thing three times while saying it is not there.
 *
 * @param {string} text - One claim's body.
 * @returns {Array<{kind: "contradiction", span: string, times: number, marker: string, label: string}>}
 */
function selfContradictions(text) {
  const body = String(text || "");
  const correction = SELF_CORRECTION_MARKERS.map(({ label, re }) => {
    const hit = body.match(re);
    return hit ? { label, matched: hit[0] } : null;
  }).filter(Boolean);
  if (!correction.length) return [];

  const repeated = [...quotedTokenCounts(body).entries()]
    .filter(([, n]) => n >= REPEATED_TOKEN_MIN)
    .map(([token, n]) => ({ token, n }));
  if (!repeated.length) return [];

  return repeated.map(({ token, n }) => ({
    kind: "contradiction",
    span: token,
    times: n,
    marker: correction[0].matched,
    label: [...new Set(correction.map((c) => c.label))].join(", "),
  }));
}

/**
 * The extractor's scaffolding label at the head of a claim, if it has one.
 *
 * @param {string} text - A claim body, or a published bullet.
 * @returns {{kind: "scaffolding-label", span: string, marker: string}|null}
 */
function scaffoldingLabelIn(text) {
  const body = String(text || "").trim();
  const match = SCAFFOLDING_LABEL.exec(body);
  if (!match) return null;
  return { kind: "scaffolding-label", span: match[1], marker: match[0] };
}

/**
 * Strip the scaffolding label off a claim body.
 *
 * @param {string} text - A claim body.
 * @returns {string} The body without its leading label; unchanged when it has none.
 */
function stripScaffoldingLabel(text) {
  const body = String(text || "");
  const match = SCAFFOLDING_LABEL.exec(body.trim());
  if (!match) return body;
  return body.trim().slice(match[0].length).trim();
}

/**
 * Every unfinished-prose defect in one piece of text, in one shape a caller can report.
 *
 * @param {string} text
 * @returns {Array<{kind: string, span: string, marker: string, label: string}>}
 */
function unfinishedProseIn(text) {
  return [...draftingAsides(text), ...selfContradictions(text)];
}

/**
 * The audit's findings over a published artifact: every line that carries unfinished prose, named.
 *
 * MEDIUM, not HIGH, and that is a decision worth stating. A drafting note is a defect a reader can see
 * and a re-read can fix; it is not a corrupted record, and it does not make the volume's other claims
 * untrustworthy. Making it HIGH would stop a volume over one stray parenthesis, which is the mistake
 * the coverage guard already made once (gotcha 99). What makes it bite is not its severity but the fact
 * that it names the line, in the report the grader reads.
 *
 * @param {string} markdown - The artifact as it is on disk.
 * @param {{file: string, volume: number|string, step?: string}} opts
 * @returns {PostMortemFinding[]}
 */
function unfinishedProseFindings(markdown, { file, volume, step = "reference-audit" } = {}) {
  const lines = String(markdown === undefined || markdown === null ? "" : markdown).split("\n");
  /** @type {Array<{line: number, text: string, defects: Array<Object>}>} */
  const flagged = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const defects = unfinishedProseIn(line);
    const label = scaffoldingLabelIn(bulletBodyOf(line));
    if (label) defects.push(label);
    if (defects.length) flagged.push({ line: index + 1, text: line, defects });
  });
  if (!flagged.length) return [];

  const detail = flagged
    .map((f) => `  - line ${f.line}: ${f.defects.map((d) => (d.kind === "aside"
      ? `a drafting aside — (${d.span}) — flagged by «${d.marker}»`
      : d.kind === "scaffolding-label"
        ? `the extractor's own label 「${d.span}」 typed into the claim itself`
        : `quotes '${d.span}' ${d.times} times in one bullet, beside its own correction (${d.label})`)).join("; ")}`)
    .join("\n");

  return [
    finding(
      "MEDIUM",
      "reference-claim-carries-unfinished-prose",
      step,
      volume,
      file,
      `${flagged.length} line(s) of ${file} carry the writer's own drafting work rather than a claim about ` +
        `the book:\n${detail}\n` +
        "A drafting aside is a note the writer left itself about a job it had not finished; a claim that " +
        "quotes the same span three times while saying it is not present is the writer arguing with itself " +
        "mid-sentence; a claim that opens with the extraction pass's own label is scaffolding left in a " +
        "document a translator is told to trust. None of the three is guidance a translator can use, and " +
        "all three are fixable by re-reading the chapter the claim cites."
    ),
  ];
}

/**
 * The claim inside one published bullet, without its `**Label**:` prefix.
 *
 * The scaffolding label sits after the bullet's own label and before the claim: `- **Pronouns**: NEW
 * CHARACTER. Uses 私 …`. Matching the shape against the whole line would never fire, because the line
 * starts with a dash.
 *
 * @param {string} line - One line of a rendered artifact.
 * @returns {string}
 */
function bulletBodyOf(line) {
  const match = /^-\s+\*\*[^*]+\*\*:\s*(.*)$/.exec(String(line || "").trim());
  return match ? match[1] : String(line || "");
}

/**
 * Screen one claim before it is filed.
 *
 * The three shapes get different answers, because they are three different defects:
 *
 *   - a **body** with unfinished prose is the claim's own assertion being unfinished or self-contradicting,
 *     so the claim is refused;
 *   - an **example** with a drafting aside glued to it is a citation that is not a citation. The claim
 *     stands — its evidence is proved separately — and the dirty citation is dropped and named;
 *   - a **body** that opens with the extraction pass's own label is a claim with scaffolding on it. The
 *     claim stands and the label is taken off, in `body`, and named in `dropped`. Stripping is the whole
 *     answer here: the label asserts nothing about the book, and the record already says the same thing
 *     as `established_volume`.
 *
 * Nothing else here edits prose. A defective span is refused whole, and the refusal is reported.
 *
 * @param {Object} claim
 * @param {string} claim.body - The claim's own assertion.
 * @param {Array<string>} [claim.examples] - The spans it offers as evidence.
 * @returns {{ok: boolean, body: string, examples: Array<string>, dropped: Array<{example: string, because: string}>, because: string|null}}
 */
function screenClaim({ body, examples = [] }) {
  const bodyDefects = unfinishedProseIn(body);
  if (bodyDefects.length) {
    return {
      ok: false,
      body,
      examples: Array.isArray(examples) ? examples : [],
      dropped: [],
      because: bodyDefects
        .map((d) => (d.kind === "aside"
          ? `a drafting aside in the claim's own prose — (${d.span}) — flagged by «${d.marker}»`
          : `it quotes '${d.span}' ${d.times} times in the same breath as its own correction (${d.label})`))
        .join("; "),
    };
  }

  const label = scaffoldingLabelIn(body);
  const strippedBody = label ? stripScaffoldingLabel(body) : body;

  /** @type {Array<string>} */
  const kept = [];
  /** @type {Array<{example: string, because: string}>} */
  const dropped = [];
  if (label) {
    dropped.push({
      example: `label: ${label.span}`,
      because: `the claim opens with the extraction pass's own label 「${label.span}」, which is scaffolding, not a claim about the book`,
    });
  }
  for (const example of Array.isArray(examples) ? examples : []) {
    const defects = draftingAsides(example);
    if (defects.length) {
      dropped.push({ example: String(example).slice(0, 200), because: `(${defects[0].span}) — flagged by «${defects[0].marker}»` });
      continue;
    }
    kept.push(example);
  }
  return { ok: true, body: strippedBody, examples: kept, dropped, because: null };
}

module.exports = {
  DRAFTING_JOB_MARKERS,
  SELF_CORRECTION_MARKERS,
  REPEATED_TOKEN_MIN,
  draftingAsides,
  selfContradictions,
  scaffoldingLabelIn,
  stripScaffoldingLabel,
  unfinishedProseIn,
  unfinishedProseFindings,
  screenClaim,
};
