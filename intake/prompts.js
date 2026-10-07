/**
 * What the intake agent is told. The system prompt is the folder-intake brief (what to
 * look at, how to decide, the exact manifest JSON shape to write) plus the tool note
 * appended in code, because the shared AGENT_TOOLS_NOTE promises the plain file tools
 * and this role also has the epub tools — and its gate shuts the plain tools at .epub
 * paths: a book is read with the epub tools or not at all, and never written over.
 *
 * The turn prompt names the fixed values the agent must use verbatim (a .env
 * SERIES_NAME overrides the agent's decision) and the committed layout it may not
 * rename. The correction turn shows the agent its own error, including a duplicate
 * book.
 *
 * Part of the get-translation-target.js layer (split out of the original single file).
 */

require("dotenv").config();
const fs = require("fs").promises;
const path = require("path");
require("../types"); // JSDoc type definitions
const { transformUserPrompt } = require("../utils/prompt");
const projectRoot = path.resolve(__dirname, "..");

const { DRAFT_MANIFEST_FILE_NAME, PLAN_FILE_NAME, discoverSampleChars } = require("./config");

/** Prompt pair for the intake agent (mode-agnostic files; the tool note is appended in code). */
const SYSTEM_PROMPT_FILE = path.join(projectRoot, "system-prompts", "translation-target.md");

const USER_PROMPT_FILE = path.join(projectRoot, "user-prompts", "translation-target.md");


/**
 * Appended to the intake system prompt so the prompt file stays mode-agnostic
 * (the AGENT_TOOLS_NOTE pattern) and the agent is told about the epub tools,
 * which are not part of the usual file-tool set.
 *
 * @type {string}
 */
const INTAKE_TOOLS_NOTE = `

## Tools (agent mode)

Your working folder is the series location; always use paths relative to it.
- listFiles(dirPath, recursive: true) — inspect the folder. Pass recursive: true, or you only see the top level and miss books inside subfolders. dirPath is a FOLDER, never a file.
- readFile / grep — plain-text files only. grep searches a FOLDER (dirPath), not one file; narrow it with glob, which is a filename ENDING (".md"), not a wildcard ("*.md" matches nothing). The file tools REFUSE .epub paths: an epub is a zip, and reading one as text returns binary junk, so readFile or grep on a book is blocked rather than wasted.
- epubInfo(filePath) — open a book: its catalog card (title, author, language tag, the series name and book number stored inside it) and its section list.
- readEpubText(filePath, section, offset, limit) — sample a bounded slice of one section's text.
- stageVolume({ sourceFile, folder, as }) — create a volume folder and put a source in it (the book is linked, not duplicated). It never touches the original.
- writeFile — write the manifest and the plan document. Always write the WHOLE file with writeFile; never append.
- You cannot delete files, and you cannot write over a book file.
- **CRITICAL: both output files must be written with writeFile. A chat reply is not saved to disk — if you put the JSON in your reply instead of calling writeFile, the manifest will not exist and the run will fail.**
`;


/**
 * Load the intake system prompt and append the tool note.
 * @returns {Promise<string>}
 */
async function loadIntakeSystemPrompt() {
  return (await fs.readFile(SYSTEM_PROMPT_FILE, "utf-8")) + INTAKE_TOOLS_NOTE;
}


/**
 * Render the "fixed values" block: what .env pins down (if anything) and what
 * is left to the agent. The target language is always fixed — the agent cannot
 * know which language the user wants to read the books in.
 *
 * @param {{seriesName?: string, sourceLanguage?: string, targetLanguage: string}} overrides
 * @returns {string} A non-empty Markdown block.
 */
function fixedValuesBlock({ seriesName, sourceLanguage, targetLanguage }) {
  const lines = [];
  if (seriesName) lines.push(`- Series name — use exactly this: ${seriesName}`);
  if (sourceLanguage) lines.push(`- Source language — use exactly this: ${sourceLanguage}`);
  lines.push(`- Target language — fixed by configuration, use exactly this: ${targetLanguage}`);
  if (seriesName && sourceLanguage) {
    lines.push(
      "- The series name and source language are fixed above. Still check them against what you read, and report any conflict in discovery.evidence."
    );
  } else {
    lines.push("- Everything not listed above is yours to decide from what you actually read.");
  }
  return `## Fixed values\n\n${lines.join("\n")}`;
}


/**
 * Render the "existing folders" block — the committed layout, so the agent
 * reuses a folder name that already holds pipeline output instead of orphaning
 * it.
 *
 * @param {CommittedVolumeDir[]} committed - From readCommittedLayout().
 * @returns {string} A non-empty Markdown block.
 */
function committedLayoutBlock(committed) {
  const worked = committed.filter((c) => c.hasPipelineOutput);
  const plain = committed.filter((c) => !c.hasPipelineOutput && c.sources.length > 0);
  if (worked.length === 0 && plain.length === 0) {
    return "## Existing folders\n\nNone — this folder holds no pipeline output yet.";
  }
  const lines = [];
  if (worked.length > 0) {
    lines.push(
      "These folders already hold pipeline output. **Reuse their names** for the book staged inside them — renaming one would orphan the work already done there:"
    );
    for (const c of worked) {
      lines.push(`- ${c.folder}/ (${c.sources.map((s) => s.file).join(", ") || "no source staged yet"})`);
    }
  }
  if (plain.length > 0) {
    lines.push("These folders exist but hold no pipeline output yet (you may rename or replace them):");
    for (const c of plain) lines.push(`- ${c.folder}/ (${c.sources.map((s) => s.file).join(", ")})`);
  }
  return `## Existing folders\n\n${lines.join("\n")}`;
}


/**
 * Build the intake agent's user turn from the user-prompt template.
 *
 * @param {{seriesDir: string, overrides: {seriesName?: string, sourceLanguage?: string, targetLanguage: string}, committed: CommittedVolumeDir[]}} p
 * @returns {Promise<string>} The turn prompt.
 */
async function buildDiscoveryTurnPrompt({ seriesDir, overrides, committed }) {
  const template = await fs.readFile(USER_PROMPT_FILE, "utf-8");
  return transformUserPrompt(template, {
    SERIES_LOCATION: seriesDir,
    MANIFEST_FILE: DRAFT_MANIFEST_FILE_NAME,
    PLAN_FILE: PLAN_FILE_NAME,
    SAMPLE_CHARS: String(discoverSampleChars()),
    FIXED_VALUES_BLOCK: fixedValuesBlock(overrides),
    COMMITTED_LAYOUT_BLOCK: committedLayoutBlock(committed),
  });
}


/**
 * The correction turn: the same agent gets its own validation error and fixes
 * its plan (the QA-loop feedback pattern, applied to the plan of record) before
 * the attempt is thrown away for a fresh agent.
 *
 * @param {string} problem - The validation error message.
 * @returns {string} The turn prompt.
 */
function buildCorrectionTurnPrompt(problem) {
  return [
    `Your plan failed validation. Fix it and write ${DRAFT_MANIFEST_FILE_NAME} again`,
    "with writeFile — the whole file, same schema, nothing but the JSON object.",
    "",
    "Validation error:",
    problem,
    "",
    "Keep everything that was already correct. If you change a volume's folder,",
    "stage that source into the new folder with stageVolume first, and make",
    '"sourceFile" point at the file that is really on disk.',
  ].join("\n");
}

// ─── Running the intake agent ───────────────────────────────────────────────

// The malformed-tool-call guard (emittedToolCallAsText + assertRealToolCalls)
// is shared by every file-writing task — see utils/agents.js (AGENTS.md
// gotcha 18). Without it, a no-op turn just ends as "no manifest found" and the
// retry loop burns attempts on the same broken endpoint.


module.exports = {
  SYSTEM_PROMPT_FILE,
  USER_PROMPT_FILE,
  INTAKE_TOOLS_NOTE,
  loadIntakeSystemPrompt,
  fixedValuesBlock,
  committedLayoutBlock,
  buildDiscoveryTurnPrompt,
  buildCorrectionTurnPrompt,
};
