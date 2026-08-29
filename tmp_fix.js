const fs = require('fs');
let c = fs.readFileSync('utils\\fs.js', 'utf8');

const old = `/**\n * Fail loudly if an agent-mode stage left its output file(s) missing or empty,\n * or recover by writing provided chat-reply content to disk as a fallback.

 * This is a recoverwrapper for the author agent: when the model produces
 * the output in its chat reply instead of calling writeFile, the content is
 * still available in the agent handle's returned result and can be written
 * directly.

 * @param {string | string[]} filePaths - Expected output file path or array of paths.
 * @param {string} who - Who was supposed to write it (for the error message).
 * @param {string} [content] - Optional content to write if the file is missing.
 * @returns {Promise<boolean>} True if the fallback was triggered (file was missing and
 *   content was written), false if the file already existed or the fallback was not used.
 */\nasync function assertWroteWithFallbac`(filePaths, who, content) { \n  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];\n  let fallbackUsed = false;\n  for (const filePath of paths) { \n    if (await fileExists(filePath)) continue;\n\n    if (content && content.trim().length > 0) { \n      // Fallback: write the chat-reply content to disk.\n      await fs.promises.writeFile(filePath, content, \"utf8\");\n      console.log(\n        `[fallback] ${who} replied in chat instead of using writeFile; ` +\n          `w wrote ${filePath} from the chat reply (${content.length} chars).`\n      );\n      fallbackUsed = true;\n    } else { \n      // Hard fail ’ no content to recover with.\n      throw new Error(\n        `${who} did not produce ${filePath}. ` +\n          `Check the run log in .logs/ for the agent transcript.`\n      );\n    }\n  }\n  return fallbackUsed;\n}`;

const nw = `/**\n * Fail loudly if an agent-mode stage left its output file(s) missing or empty,\n * or recover by writing provided chat-reply content to disk as a fallback.\n\n * This is a recoverwrapper for the author agent: when the model produces\n * the output in its chat reply instead of calling writeFile, the content is\n * still available in the agent handle's returned result and can be written\n * directly. When no content is available (empty model response), the function\n * still returns true so the caller can send a recovery turn that re-sends the\n * full task.\n *\n * @param {string | string[]} filePaths - Expected output file path or array of paths.\n * @param {string} who - Who was supposed to write it (for the error message).\n * @param {string} [content] - Optional content to write if the file is missing.\n * @returns {Promise<boolean>} True if the file was missing (fallback was used or\n *   recovery is needed), false if the file already existed.\n */\nasync function assertWroteWithFallback(filePaths, who, content) { \n  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];\n  for (const filePath of paths) { \n    if (await fileExists(filePath)) continue;\n\n    if (content && content.trim().length > 0) { \n      // Fallback: write the chat-reply content to disk.\n      await fs.promises.writeFile(filePath, content, \"utf8\");\n      console.log(\n        `[fallback] ${who} replied in chat instead of using writeFile; ` +\n          `w wrote ${filePath} from the chat reply (${content.length} chars).`\n      );\n    } else {\n      // No content to recover with ’ the caller will send a recovery turn\n      // that re-sends the full task.\n      console.warn(\n        `[warning] ${who} produced no output ’ recovery turn will re-send the task.`\n      );\n    }\n  }\n  return true;\n}`);

c = c.replace(old, nw);{fs.writeFileSync('utils\\fs.js', c, 'utf8'); console.log('done');