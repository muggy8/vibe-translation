/**
 * harness-smoke.js — Phase 1 smoke test for harness.js against the
 * configured endpoint (.env).
 *
 * Run: node harness-smoke.js            (all three checks)
 *      node harness-smoke.js one-shot   (just check 1)
 *      node harness-smoke.js research   (just check 2)
 *      node harness-smoke.js fs         (just check 3)
 */
const fs = require("fs");
const path = require("path");
const harness = require("./harness");

/** [1/3] runOneShot: the streaming one-shot path (old callAi replacement). */
async function testOneShot() {
  console.log("--- [1/3] runOneShot ---");
  const text = await harness.runOneShot({
    systemPrompt: "You are a test agent. Reply with exactly one word: OK",
    messages: [{ text: "ping" }],
    label: "smoke-one-shot",
  });
  if (!text || !text.trim()) throw new Error("empty result");
  console.log(`[1/3] PASS (text: ${JSON.stringify(text.trim().slice(0, 80))})`);
}

/** [2/3] createAgentHandle + wiki tools: the research agent path. */
async function testResearchAgent() {
  console.log("--- [2/3] research agent (wiki tools) ---");
  const handle = await harness.createAgentHandle({
    name: "smoke-researcher",
    systemPrompt:
      "You are a research agent. You have wiki_search and wiki_extract tools. " +
      "Follow the user's instruction exactly, using the fewest tool calls possible.",
    tools: harness.createWikiTools(),
  });
  try {
    const res = await handle.sendTurn(
      "Use wiki_search exactly once with query 'Camel' and lang 'en'. " +
        "Then reply with the first title from the result, nothing else."
    );
    if (!res.text.trim()) throw new Error("empty result");
    console.log(`[2/3] PASS (text: ${JSON.stringify(res.text.trim().slice(0, 120))})`);
  } finally {
    await handle.close();
  }
}

/** [3/3] createGatedFsTools: the write-gate logic + a live writing agent. */
async function testFsGate() {
  console.log("--- [3/3] gated fs agent ---");
  const base = path.resolve(__dirname, ".harness-smoke");
  const allowedDir = path.join(base, "volume");
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(allowedDir, { recursive: true });

  const { tools, approve } = await harness.createGatedFsTools({
    cwd: base,
    allowedDirs: [allowedDir],
  });

  // Deterministic checks of the gate itself (no model involved).
  const checks = {
    "write inside allowed dir": approve({ toolName: "writeFile", input: { filePath: "volume/ok.md" } }) === true,
    "write outside allowed dir": approve({ toolName: "writeFile", input: { filePath: "../escape.md" } }) === false,
    "read anywhere": approve({ toolName: "readFile", input: { filePath: "../anything.md" } }) === true,
    "delete always denied": approve({ toolName: "deleteFile", input: { filePath: "volume/x.md" } }) === false,
  };
  for (const [label, ok] of Object.entries(checks)) {
    if (!ok) throw new Error(`gate logic broken: ${label}`);
  }
  console.log("[3/3] gate logic PASS");

  const handle = await harness.createAgentHandle({
    name: "smoke-writer",
    systemPrompt:
      "You are a file-writing test agent. Use the writeFile tool exactly as " +
      "instructed. If a write is denied or rejected, note that and continue.",
    tools,
    approve,
  });
  try {
    await handle.sendTurn(
      "Do both of these writes with writeFile, in this order: " +
        "1) file_path 'volume/gate-test.md', content 'gate ok'. " +
        "2) file_path '../gate-escape.md', content 'escaped'. " +
        "Then reply with exactly: DONE"
    );
    const inside = path.join(allowedDir, "gate-test.md");
    const outside = path.join(base, "gate-escape.md");
    const insideOk =
      fs.existsSync(inside) && fs.readFileSync(inside, "utf8").includes("gate ok");
    const outsideBlocked = !fs.existsSync(outside);
    if (!insideOk) throw new Error("expected file was not written inside the allowed dir");
    if (!outsideBlocked) throw new Error("WRITE GATE FAILED: file escaped the allowed dir");
    console.log("[3/3] PASS (inside write ok, outside write blocked)");
  } finally {
    await handle.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const ALL = [
  ["one-shot", testOneShot],
  ["research", testResearchAgent],
  ["fs", testFsGate],
];
const which = process.argv[2];
const tests = which ? ALL.filter(([name]) => name === which) : ALL;

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (err) {
      failed++;
      console.error(`[${name}] FAIL: ${err.message}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
})();
