/**
 * The two prompt blocks this task builds in code: the running tally that tells a chapter's extraction
 * pass what this volume's own earlier chapters have already produced, and the block that hands it
 * **this series' declared register questions**.
 *
 * The prompt *files* stay mode-agnostic (AGENTS.md rule 6); what is assembled here is per-series text
 * that cannot live in a shared file. The author turn, the validator turn, the feedback turn and the
 * findings-merge turn went with the route that sent them (git history at commit 75e59a7).
 *
 * ## Why the register block is appended rather than written into the prompt file
 *
 * `system-prompts/character-voice-extract.md` asks the extraction pass to answer **the questions this
 * series declares** (plan 06 §4), and it names none of them — because a question is a fact about one
 * book, not a fact about the pipeline. The declaration is read from the series' own plan of record
 * (`utils/reference-store/register/declaration.js`), and this file turns it into the text the model is
 * shown. That is the same shape `AGENT_TOOLS_NOTE` and `style-guide/prompts.js` use: the shared file
 * states the role, the code appends what this run is about.
 *
 * The block is the *only* place a question or a value reaches the model. Nothing here holds a question
 * of its own: a series that declares none is told, in as many words, to answer none. That is the
 * owner's rule (`test/test-no-language-axis-list.js`), and it is why the three branches below all end
 * in an instruction rather than in a list.
 *
 * Part of the character-voice.js layer (split out of the original single file).
 */

require("dotenv").config();
require("../types");

/**
 * The block that tells a chapter's extraction pass what this volume's own earlier chapters have
 * already produced.
 *
 * Why it exists. `chapterSegmentNote` tells every chapter of a volume that "the cumulative reference
 * material already covers the chapters before it". That is only true of a pass that has been compiling
 * as it went. In the reading-only route (`character-voice/reading.js` → the record → the render) there
 * is no such file, so the same sentence would be a lie and the extractor would re-claim what chapter 2
 * already found. This block is the honest substitute: it names the chapters already read and the claims
 * they produced, in a shape smaller than the duplicate output it prevents.
 *
 * It lists **who and what kind**, not the claim text: the extractor needs to know a claim exists, not
 * to read it, and the claim text is already in the record.
 *
 * @param {{installmentNumber: string|number, segmentsTotal: number, doneSegments: string[], entries: Array<Object>}} opts
 * @returns {string|null} The block, or null when this is the first chapter (there is nothing yet).
 */
function buildAlreadyExtractedNote({ installmentNumber, segmentsTotal, doneSegments, entries }) {
  if (!Array.isArray(doneSegments) || doneSegments.length === 0) return null;

  /** @type {Map<string, Map<string, number>>} character → quirk label → how many claims */
  const byCharacter = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    // A POV claim names its character in `assignedCharacter`, not `character`. Reading only
    // `character` puts every POV claim under a heading that says nobody was named, which is noise
    // shown to the model.
    const named = entry.type === "pov" && typeof entry.assignedCharacter === "string" && entry.assignedCharacter.trim()
      ? entry.assignedCharacter.trim()
      : (typeof entry.character === "string" ? entry.character.trim() : "");
    const name = named || (entry.type === "pov" ? "(POV, unassigned)" : "(no character named)");
    const kind = entry.type === "pov"
      ? (typeof entry.marker === "string" && entry.marker.trim() ? `POV ${entry.marker.trim()}` : "POV")
      : (typeof entry.quirkType === "string" && entry.quirkType.trim() ? entry.quirkType.trim() : "voice");
    const kinds = byCharacter.get(name) || new Map();
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    byCharacter.set(name, kinds);
  }

  const lines = [...byCharacter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, kinds]) => {
      const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
      return `- ${name}: ${[...kinds.entries()].map(([kind, n]) => `${kind} x${n}`).join(", ")} (${total} claim(s))`;
    });

  return (
    `## Already extracted in volume ${installmentNumber}\n\n` +
    `The chapters already read in this pass, in reading order: ${doneSegments.join(", ")} ` +
    `(${doneSegments.length} of ${segmentsTotal}). What they have already recorded:\n\n` +
    (lines.length ? lines.join("\n") : "- nothing yet") +
    `\n\nThe reference above covers the volumes BEFORE volume ${installmentNumber}; the list above is ` +
    `what this volume's own earlier chapters produced. Do not repeat a claim that is already recorded — ` +
    `extract only what this chapter adds or changes.`
  );
}


// ─── The register block: this series' declared questions, in the model's own words ────

/** The heading the extraction prompt points at when it says "named above". */
const REGISTER_NOTE_HEADING = "## Register questions declared for this series";

/** How many of an axis's declared values one line may carry before the list is wrapped. */
const REGISTER_NOTE_VALUES_PER_LINE = 12;

/** How many of an axis's own evidence lines the block carries. */
const REGISTER_NOTE_EVIDENCE_LINES = 4;

/**
 * The lines one declared axis contributes to the block.
 *
 * Every line is the declaration's own text, copied rather than paraphrased: a paraphrase is where a
 * pipeline would smuggle its own idea of the question back in, and the whole point of the declaration
 * is that the question belongs to the book. The accepted answers are given as a closed list because
 * the filing door refuses anything outside it (`utils/reference-store/register/filing.js`), and the
 * extractor is better told the boundary than surprised by it.
 *
 * @param {Object} axis - One axis as `describeRegisterDeclaration` returns it.
 * @returns {string[]}
 */
function registerAxisNoteLines(axis) {
  const lines = [`- \`${axis.id}\` — ${axis.asks}`];

  const values = Array.isArray(axis.values) ? axis.values : [];
  for (let i = 0; i < values.length; i += REGISTER_NOTE_VALUES_PER_LINE) {
    lines.push(
      `  Answer it with exactly one of: ${values.slice(i, i + REGISTER_NOTE_VALUES_PER_LINE).map((v) => `\`${v}\``).join(", ")}.`
    );
  }
  if (axis.scope === "character-addressee") {
    lines.push(
      "  This answer belongs to a pair: say in `description` **whom** the character is addressing when they speak this way."
    );
  }
  if (axis.guidance) lines.push(`  The intake's own note on this question: ${axis.guidance}`);
  if (axis.renders && typeof axis.renders === "object") {
    const decided = Object.entries(axis.renders).map(([value, rendering]) => `\`${value}\` → ${rendering}`);
    if (decided.length) lines.push(`  How the translation renders each answer: ${decided.join("; ")}.`);
  }
  if (Array.isArray(axis.evidence) && axis.evidence.length) {
    lines.push(
      `  Where the intake saw this question in the book: ${axis.evidence.slice(0, REGISTER_NOTE_EVIDENCE_LINES).join("; ")}` +
        (axis.evidence.length > REGISTER_NOTE_EVIDENCE_LINES ? ` (and ${axis.evidence.length - REGISTER_NOTE_EVIDENCE_LINES} more)` : "") +
        "."
    );
  }
  return lines;
}

/**
 * The block that hands the extraction pass this series' declared register questions.
 *
 * Three shapes, and the difference between them is the design (plan 06 §4):
 *
 *   - **declared** — the questions, their accepted answers, and the rule that a claim names one or
 *     names nothing.
 *   - **empty** — the series declared none and said why. The block says so and forbids an `axis`, so a
 *     model cannot fill a field it was never asked about.
 *   - **absent** or **malformed** — there is no usable declaration. Same instruction, different reason:
 *     the stage refuses these, but `extract-voice` / `rebuild-voice` still read a book, and the honest
 *     thing to tell the extractor is that naming a question here costs the claim.
 *
 * @param {{state: string, axes: Array<Object>, note: string|null}} [declaration] - What
 *   `describeRegisterDeclaration` / `readRegisterDeclaration` answered. Missing is read as `absent`.
 * @returns {string} The block, heading included. Never empty: a series with no questions still has to
 *   be told it has none.
 */
function buildRegisterDeclarationNote(declaration) {
  const state = declaration && declaration.state ? declaration.state : "absent";
  const axes = declaration && Array.isArray(declaration.axes) ? declaration.axes : [];

  if (state !== "declared" || axes.length === 0) {
    const because =
      state === "empty"
        ? `This series declares no register questions, and says why: "${declaration.note}".`
        : state === "malformed"
          ? "This series' register declaration is present but malformed, so no question can be asked from it."
          : "This series has no register declaration.";
    return [
      REGISTER_NOTE_HEADING,
      "",
      because,
      "Name no `axis` and no `value` in any claim you file. A claim that names a question this series",
      "never declared is refused when it is filed, and the claim is lost.",
    ].join("\n");
  }

  return [
    REGISTER_NOTE_HEADING,
    "",
    `This series declares ${axes.length} register question(s). They were decided from this book, and`,
    "they are the only questions a voice claim may answer by name. Name the one your claim answers in",
    "`axis` and answer it in `value`, spelled exactly as declared. A claim that answers none of them",
    "names neither.",
    "",
    ...axes.flatMap(registerAxisNoteLines),
  ].join("\n");
}

/**
 * The system prompt one extraction call is actually sent: the shared role file, plus this series'
 * declared questions.
 *
 * Appended, not merged — the same shape `style-guide/prompts.js` and `jump-in-wiki/prompts.js` use for
 * `AGENT_TOOLS_NOTE`. The prompt file stays the same text for every series, so the prompt audit and the
 * diff can read it, and what varies per series is visibly the code's doing.
 *
 * @param {string} baseSystemPrompt - The contents of `system-prompts/character-voice-extract.md`.
 * @param {Object} [declaration] - The series' declaration, as described by the register layer.
 * @returns {string}
 */
function buildExtractSystemPrompt(baseSystemPrompt, declaration) {
  return `${baseSystemPrompt}\n\n${buildRegisterDeclarationNote(declaration)}\n`;
}

module.exports = {
  buildAlreadyExtractedNote,
  REGISTER_NOTE_HEADING,
  REGISTER_NOTE_VALUES_PER_LINE,
  REGISTER_NOTE_EVIDENCE_LINES,
  registerAxisNoteLines,
  buildRegisterDeclarationNote,
  buildExtractSystemPrompt,
};
