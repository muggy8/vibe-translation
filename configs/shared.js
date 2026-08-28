/**
 * configs/shared.js — Shared configuration constants used across the ai-client
 * modules.
 *
 * This file exists to break circular dependencies and eliminate duplication.
 * Both `glossary.js` and `jump-in-wiki.js` import `AGENT_TOOLS_NOTE` from
 * here so the prompt-injection text lives in exactly one place.
 */

/**
 * Appended to the system prompts of agent-mode stages so the mode-agnostic
 * prompt files keep working in both modes.
 *
 * @type {string}
 */
const AGENT_TOOLS_NOTE = `

## File Tools (agent mode)

You have file tools: readFile, listFiles, grep, writeFile, and editFile.
- Your working folder is the volume folder; use paths relative to it (e.g. "wiki.md").
- Read every material listed in the request with readFile before doing anything. Large files may need several reads (use offset/limit to page through).
- Write your output files with writeFile (complete contents) or editFile (targeted fixes).
- Never paste file contents into your chat reply. When you are done, reply with a short summary: what you read, what you wrote, and any problems you hit.
`;

module.exports = {
  AGENT_TOOLS_NOTE,
};
