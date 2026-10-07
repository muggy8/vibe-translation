/**
 * harness.js — the AI layer: one-shot calls, agent handles, tool factories,
 * provider plumbing, run logging, and the guards around a model call.
 *
 * This is the ONLY way this project talks to the model. Everything else is a
 * caller.
 *
 *   - runOneShot: one tool-less call (streaming with a non-streaming fallback,
 *     retries, an idle deadline, and a throw on empty — a workflow that persisted
 *     an empty reply would corrupt an artifact, so an empty result fails the run).
 *   - createAgentHandle: a tool-using agent backed by an OpenHarness Session.
 *     Auto-compaction is OFF on every handle: the library's compaction is a lossy
 *     summary of the agent's own conversation, and it used to fire silently inside
 *     stage turns, which is how "the agent quietly stopped honoring the honorific
 *     rules" first showed up (AGENTS.md gotcha 56 / 78). With it off, a request
 *     that genuinely does not fit comes back as the server's own refusal, tagged
 *     as the size failure the whole-installment -> chapter-by-chapter fallback
 *     repairs.
 *   - createGatedFsTools / createEpubTools / createWikiTools: the sandboxes. The fs
 *     write gate confines writes to the volume folder and never over a staged book;
 *     deleteFile is not offered at all and the gate refuses it anyway (gotcha 8).
 *
 * This file is the public face of the layer: apart from the declarations noted
 * below it holds no logic, only re-exports. The implementation lives in
 * ./ai/ — open the module that owns the behaviour you are changing
 * instead of reading all of them.
 */

require("dotenv").config();
require("./types"); // JSDoc type definitions

const __log = require("./ai/log");
const __env = require("./ai/env");
const __provider = require("./ai/provider");
const __tools_wiki = require("./ai/tools-wiki");
const __tools_epub = require("./ai/tools-epub");
const __tools_fs = require("./ai/tools-fs");
const __turn = require("./ai/turn");
const __one_shot = require("./ai/one-shot");
const __agent = require("./ai/agent");
const __endpoint = require("./ai/endpoint");

module.exports = {
  ...__log,
  ...__env,
  ...__provider,
  ...__tools_wiki,
  ...__tools_epub,
  ...__tools_fs,
  ...__turn,
  ...__one_shot,
  ...__agent,
  ...__endpoint,
};

const { runOneShot } = __one_shot;

// ─── Ad-hoc CLI ─────────────────────────────────────────────────────────────
// node harness.js --system "You are helpful" --text "Hello"
// node harness.js --system "You are helpful" --file ./img.png --name "img.png" --text "Describe this"

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };
  const system = getArg("system");
  const text = getArg("text");
  const file = getArg("file");
  const name = getArg("name");

  const messages = [];
  if (file) {
    if (!name) {
      console.error("Error: --file requires --name");
      process.exit(1);
    }
    messages.push({ file, name });
  }
  if (text) messages.push({ text });
  if (messages.length === 0) {
    console.error(
      'Usage: node harness.js --system "system prompt" --text "text"\n' +
        '       node harness.js --system "system prompt" --file path --name "filename" --text "text"'
    );
    process.exit(1);
  }
  if (!system) {
    console.error("Error: --system is required");
    process.exit(1);
  }

  runOneShot({ systemPrompt: system, messages })
    .then((result) => {
      console.log(result);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
