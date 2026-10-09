/**
 * test/test-chunked-preproduction.js — the chapter-by-chapter path of the two cumulative
 * reference tasks: the character voice reference and the style guide.
 *
 * Why this suite exists: both tasks have a whole-installment path and a chapter-by-chapter
 * fallback, and the fallback is where the two guarantees that protect a cumulative document
 * actually live — the previous volume's copy is seeded in before any agent touches it, and the
 * carry-forward gate runs BETWEEN chapters, so a character or a category lost at chapter 3 is
 * caught at chapter 3 rather than eight chapters and one acceptance loop later. A
 * whole-installment fixture never reaches that code, so until now nothing did.
 *
 * The harness is stubbed (the wiring is what is under test, not the provider); the files, the
 * QA loop, the seed and the guards are the real ones. Everything happens in a throwaway
 * directory under the OS temp dir: this suite cannot reach the corpus it is protecting
 * (gotcha 69).
 */

const assert = require("assert");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");

const harness = require("../harness");

/** The previous volume's character voice reference: two characters, both cumulative. */
const PREV_VOICE = `# Character Voice Reference — Series, volume 05

## Characters

### 如月雨露（ジョーロ）
- Register: blunt, clipped sentence ends.
- Catchphrase: "まあね".

### 佐伯さん
- Register: formal, over-polite in front of strangers.

## POV
- Third person limited, following 如月雨露.
`;

/** The same reference with one character missing — what the between-chapter gate exists to catch. */
const SHRUNK_VOICE = `# Character Voice Reference — Series, volume 06

## Characters

### 如月雨露（ジョーロ）
- Register: blunt, clipped sentence ends.
`;

/** The previous volume's style guide: two categories, both cumulative. */
const PREV_STYLE = `# Style Guide — Series, volume 05

## Address & Honorifics
- \`-san\` is kept as \`-san\`; never expanded to "Mr." or "Ms.".

## Narration
- Past tense, third person. Keep the distance.
`;

/** The same guide with one category missing. */
const SHRUNK_STYLE = `# Style Guide — Series, volume 06

## Address & Honorifics
- \`-san\` is kept as \`-san\`; never expanded to "Mr." or "Ms.".
`;

/** The voice task owes two documents; the seed only copies the reference, so the agent writes both. */
const POV_MAP = `# POV Map — Series, volume 06

- Chapter 1: third person limited, following 如月雨露.
- Chapter 2: third person limited, following 佐伯さん.
`;

const VALIDATION_REPORT =
  "# Validation — Series, volume 06\n\n" +
  "The reference covers the chapter sources. No HIGH findings.\n\n" +
  "FINDING [LOW] chapters=ch1 — one note is longer than a voice note should be.\n";

/** The score the acceptance one-shot answers with: passing, so the loop is about the wiring. */
const PASSING_SCORE = '{"score": 88, "band": "Pass with minor edits", "note": "Carries the previous sections."}';

const SEGMENTS = [
  { id: "ch1", file: "book-ch1.md", title: "第一章", bodyChars: 100 },
  { id: "ch2", file: "book-ch2.md", title: "第二章", bodyChars: 100 },
];

/**
 * The two chapter-by-chapter flows, described by what differs between them.
 *
 * The agent-name patterns are part of the guarantee: a task that renames its chapter agents
 * stops being recognised by this stub, stops writing the files, and the assertions fail.
 */
const FLOWS = [
  {
    label: "character-voice",
    artifactName: "character-voice.md",
    validationName: "character-voice-validation.md",
    partialPrefix: "character-voice-validation-",
    prevArtifact: PREV_VOICE,
    shrunk: SHRUNK_VOICE,
    newEntriesName: "character-voice-new.json",
    // What the extraction one-shot answers with: one entry, in the shape
    // parseVoiceQuirks accepts (an entry without a `type` is filtered out).
    extractPayload: '[{"type": "quirk", "character": "如月雨露", "note": "clipped sentence ends"}]',
    // "the compile pass (chapter ch2) dropped character section(s) that … held"
    guardMessage: /the compile pass \(chapter ch2\) dropped character section\(s\)/,
    isCompileAgent: (name) => /^author-voice-\d+-ch\d+$/.test(name),
    isFeedbackAgent: (name) => /^feedback-author-/.test(name),
    /** The second document the author passes owe, which the seed does not copy in. */
    companion: (volDir) => ({ file: path.join(volDir, "pov-map.md"), content: POV_MAP }),
    load: () => require("../character-voice"),
    compare: (prev, current) => require("../character-voice").compareVoiceCarryForward(prev, current),
    /** What a chapter's compile pass adds to the reference it was handed. */
    append: "\n### 秋野桜（通称コスモス）\n- Register: warm, oblique, answers a question with a question.\n",
    /** The document the FIRST chapter's pass produces, because there is nothing to amend yet. */
    firstDraft:
      "# Character Voice Reference — Series, volume 01\n\n## Characters\n\n" +
      "### 如月雨露（ジョーロ）\n- Register: blunt, clipped sentence ends.\n",
    /** The line the section map must contain before a later pass is told where to put a character. */
    indexLine: "如月雨露（ジョーロ）",
    indexHeading: 'What "character-voice.md" already holds',
    createInstruction: "neither file exists yet",
    amendInstruction: "ALREADY holds the reference",
    buildCtx: (p) => ({
      values: {
        INSTALLMENT_NUMBER: p.installment,
        SOURCE_NAME: "Series",
        SOURCE_LANGUAGE: "Japanese",
        TARGET_LANGUAGE: "English",
      },
      folderName: p.folderName,
      volumeDir: p.volDir,
      sourceFile: path.join(p.volDir, SEGMENTS[0].file),
      bundle: {
        format: "epub",
        segments: SEGMENTS,
        wholeChars: 200,
        wholePath: path.join(p.volDir, SEGMENTS[0].file),
        sourceFingerprint: "fixture-fingerprint",
      },
      isFirst: p.isFirst,
      previousFolderName: p.previousFolderName,
      previousVoiceRefFile: p.previousArtifactFile,
      voiceOutputFile: p.artifactFile,
      povOutputFile: path.join(p.volDir, "pov-map.md"),
      validationOutputFile: p.validationFile,
      extractPrompt: "Extract the voice quirks and POV information.",
      extractSystemPrompt: "You extract voice quirks.",
      authorSystemPrompt: "You maintain the character voice reference.",
      authorTemplate: "Amend the reference for {{SOURCE_NAME}}.",
      authorUserPrompt: "Amend the reference for {{SOURCE_NAME}}.",
      validatorSystemPrompt: "You audit the character voice reference.",
      validatorPrompt: "Audit the reference.",
      validatorUserPrompt: "Audit the reference.",
      feedbackSystemPrompt: "You apply the validation findings.",
      feedbackPrompt: "Apply the findings.",
      feedbackUserPrompt: "Apply the findings.",
      acceptanceSystemPrompt: "You grade the reference.",
      acceptancePrompt: "Grade the reference.",
      chunked: true,
    }),
  },
  {
    label: "style-guide",
    artifactName: "style-guide.md",
    validationName: "style-guide-validation.md",
    partialPrefix: "style-guide-validation-",
    prevArtifact: PREV_STYLE,
    shrunk: SHRUNK_STYLE,
    newEntriesName: "style-guide-new.json",
    // The shape parseStyleObservations accepts (an entry without a `category` is filtered out).
    extractPayload: '[{"category": "Narration", "rule": "Keep the distance."}]',
    // "the compile pass (chapter ch2) dropped style-guide section(s) that … held"
    guardMessage: /the compile pass \(chapter ch2\) dropped style-guide section\(s\)/,
    isCompileAgent: (name) => /^author-style-\d+-ch\d+$/.test(name),
    isFeedbackAgent: (name) => /^author-style-feedback-/.test(name),
    companion: null,
    load: () => require("../style-guide"),
    compare: (prev, current) => require("../style-guide").compareStyleCarryForward(prev, current),
    /** What a chapter's compile pass adds to the guide it was handed. */
    append: "\n- Keep the narrator's distance from 如月雨露; do not warm the prose up.\n",
    /** The document the FIRST chapter's pass produces, because there is nothing to amend yet. */
    firstDraft:
      "# Style Guide — Series, volume 01\n\n## Address & Honorifics\n" +
      "- `-san` is kept as `-san`; never expanded to \"Mr.\" or \"Ms.\".\n",
    /** The heading the category map must list before a later pass is told where a rule belongs. */
    indexLine: "Address & Honorifics",
    indexHeading: 'What "style-guide.md" already holds, by section',
    createInstruction: "does not exist yet",
    amendInstruction: "ALREADY holds the guide",
    buildCtx: (p) => ({
      values: {
        INSTALLMENT_NUMBER: p.installment,
        SOURCE_NAME: "Series",
        SOURCE_LANGUAGE: "Japanese",
        TARGET_LANGUAGE: "English",
      },
      folderName: p.folderName,
      volumeDir: p.volDir,
      sourceFile: path.join(p.volDir, SEGMENTS[0].file),
      bundle: {
        format: "epub",
        segments: SEGMENTS,
        wholeChars: 200,
        wholePath: path.join(p.volDir, SEGMENTS[0].file),
        sourceFingerprint: "fixture-fingerprint",
      },
      isFirst: p.isFirst,
      previousFolderName: p.previousFolderName,
      previousStyleGuideFile: p.previousArtifactFile,
      styleOutputFile: p.artifactFile,
      validationOutputFile: p.validationFile,
      extractPrompt: "Extract the style observations.",
      extractSystemPrompt: "You extract style observations.",
      authorSystemPrompt: "You maintain the style guide.",
      authorTemplate: "Amend the guide for {{SOURCE_NAME}}.",
      authorUserPrompt: "Amend the guide for {{SOURCE_NAME}}.",
      validatorSystemPrompt: "You audit the style guide.",
      validatorPrompt: "Audit the guide.",
      validatorUserPrompt: "Audit the guide.",
      feedbackSystemPrompt: "You apply the validation findings.",
      feedbackPrompt: "Apply the findings.",
      feedbackUserPrompt: "Apply the findings.",
      acceptanceSystemPrompt: "You grade the guide.",
      acceptancePrompt: "Grade the guide.",
      chunked: true,
    }),
  },
];

/**
 * Run one cumulative reference task's chapter-by-chapter path and assert what it owes.
 *
 * @param {{label: string, artifactName: string, validationName: string, partialPrefix: string, prevArtifact: string, shrunk: string, guardMessage: RegExp, isCompileAgent: Function, isFeedbackAgent: Function, companion: ?Function, load: Function, compare: Function, buildCtx: Function}} flow
 */
async function runFlow(flow) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `chunked-${flow.label}-`));
  const prevDir = path.join(tmpDir, "Series(05)");
  const volDir = path.join(tmpDir, "Series(06)");
  const artifactFile = path.join(volDir, flow.artifactName);
  const validationFile = path.join(volDir, flow.validationName);
  const counters = { compile: 0, feedback: 0 };
  /** Set to N to make the Nth compile pass damage the document instead of amending it. */
  let shrinkOnCompileCall = 0;

  // Save and restore the harness methods the flow reaches for, so the suites that
  // run after this one get the real ones back.
  const real = {
    createGatedFsTools: harness.createGatedFsTools,
    createAgentHandle: harness.createAgentHandle,
    runOneShot: harness.runOneShot,
  };

  try {
    await fs.mkdir(prevDir);
    await fs.mkdir(volDir);
    await fs.writeFile(path.join(prevDir, flow.artifactName), flow.prevArtifact, "utf8");
    for (const s of SEGMENTS) {
      await fs.writeFile(path.join(volDir, s.file), `${s.title}\n\n本文。\n`, "utf8");
    }

    harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
    harness.runOneShot = async ({ label }) =>
      label.includes("extract") ? flow.extractPayload : PASSING_SCORE;
    harness.createAgentHandle = async ({ name }) => ({
      name,
      sendTurn: async () => {
        if (name.startsWith("validator-merge-")) {
          await fs.writeFile(validationFile, VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("validator-")) {
          const id = name.split("-").pop();
          await fs.writeFile(path.join(volDir, `${flow.partialPrefix}${id}.md`), VALIDATION_REPORT, "utf8");
        } else if (flow.isCompileAgent(name)) {
          counters.compile++;
          // The failure the between-chapter gate exists for: a chapter pass that
          // rewrites the document from memory instead of editing it in place.
          if (counters.compile === shrinkOnCompileCall) {
            await fs.writeFile(artifactFile, flow.shrunk, "utf8");
          } else {
            await fs.writeFile(artifactFile, flow.prevArtifact, "utf8");
          }
          if (flow.companion) {
            const c = flow.companion(volDir);
            await fs.writeFile(c.file, c.content, "utf8");
          }
        } else if (flow.isFeedbackAgent(name)) {
          counters.feedback++;
          // A feedback pass amends the document it was handed: it does not shrink it.
          await fs.writeFile(artifactFile, await fs.readFile(artifactFile, "utf8"), "utf8");
          if (flow.companion) {
            const c = flow.companion(volDir);
            await fs.writeFile(c.file, c.content, "utf8");
          }
        }
        return { text: "", toolCalls: [{ toolCallId: "1", toolName: "readFile", input: {} }] };
      },
      close: async () => {},
    });

    const runChunkedVolume = flow.load().runChunkedVolume;
    const ctx = flow.buildCtx({
      installment: "06",
      folderName: "Series(06)",
      isFirst: false,
      previousFolderName: "Series(05)",
      previousArtifactFile: path.join(prevDir, flow.artifactName),
      volDir,
      artifactFile,
      validationFile,
    });

    // 1. The happy path: the volume starts from the previous volume's copy, every
    //    chapter amends it, and the QA loop validates the result chapter by chapter.
    await runChunkedVolume(ctx);

    const written = await fs.readFile(artifactFile, "utf8");
    assert.deepStrictEqual(
      flow.compare(flow.prevArtifact, written).missing,
      [],
      `${flow.label}: every section the previous volume held is still held after the chapter passes`
    );
    assert.ok(counters.compile >= 2, `${flow.label}: every chapter got its own compile pass`);
    assert.ok(
      await fs.stat(path.join(volDir, `${flow.partialPrefix}ch1.md`)).then(() => true, () => false),
      `${flow.label}: the per-chapter validation partials were written`
    );
    assert.ok(
      await fs.stat(validationFile).then(() => true, () => false),
      `${flow.label}: the findings-merge agent consolidated the partials into the volume's report`
    );

    // The volume's own extraction results are persisted for the translation handoff, which reads
    // them without a model call. A chapter's parse that threw and was swallowed by a bare catch
    // leaves this file empty — which is invisible everywhere else in the run.
    const persisted = JSON.parse(await fs.readFile(path.join(volDir, flow.newEntriesName), "utf8"));
    assert.strictEqual(
      persisted.length,
      SEGMENTS.length,
      `${flow.label}: every chapter's extraction results were persisted for the handoff`
    );

    // 2. A chapter pass that shrinks the document is caught AT THAT CHAPTER — and the
    //    damaged copy is moved out of the next volume's way but kept as the evidence.
    counters.compile = 0;
    shrinkOnCompileCall = 2; // the second chapter's compile pass
    await fs.writeFile(artifactFile, flow.prevArtifact, "utf8");
    await assert.rejects(
      () => runChunkedVolume(ctx),
      flow.guardMessage,
      `${flow.label}: the between-chapter guard names the chapter that broke the document`
    );
    assert.strictEqual(
      await fs.stat(artifactFile).then(() => true, () => false),
      false,
      `${flow.label}: the damaged document is not left where the next volume would read it`
    );
    assert.ok(
      await fs.stat(`${artifactFile}.rejected`).then(() => true, () => false),
      `${flow.label}: the damaged document survives as the evidence`
    );
  } finally {
    Object.assign(harness, real);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── 3: the FIRST volume's chapters are told to amend, not to recreate ─────────

/**
 * The flag that decides HOW an agent is told to write a cumulative document used to answer a
 * different question from the one the instruction asks. It was set by "did the workflow copy the
 * previous volume's file in?" — and on the first volume there is no previous volume, so it stayed
 * false for chapter 8 as well, while the document the agent was told to create had been in the
 * folder since chapter 1.
 *
 * That is the shape the live run hit on volume 01: seven chapter passes, each one told to
 * `writeFile (complete contents)` a reference that grows every chapter, and the last of them shipped
 * a document missing a character the between-chapter gate then caught. The gate is the only thing
 * that can see it, and by then eight chapters of work are built on the damaged copy.
 *
 * So the instruction is read off the FILE, at the moment the pass is built: chapter 1 creates it,
 * every chapter after that amends it and is handed the map of what the earlier chapters put there.
 *
 * @param {Object} flow - One entry from FLOWS.
 */
async function testFirstVolumeIsToldToAmend(flow) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `chunked-first-${flow.label}-`));
  const volDir = path.join(tmpDir, "Series(01)");
  const artifactFile = path.join(volDir, flow.artifactName);
  const validationFile = path.join(volDir, flow.validationName);
  /** The compile passes' prompts, in the order the chapters ran. */
  const compilePrompts = [];

  const real = {
    createGatedFsTools: harness.createGatedFsTools,
    createAgentHandle: harness.createAgentHandle,
    runOneShot: harness.runOneShot,
  };

  try {
    await fs.mkdir(volDir);
    for (const s of SEGMENTS) {
      await fs.writeFile(path.join(volDir, s.file), `${s.title}\n\n本文。\n`, "utf8");
    }

    harness.createGatedFsTools = async () => ({ tools: {}, approve: async () => true });
    harness.runOneShot = async ({ label }) =>
      label.includes("extract") ? flow.extractPayload : PASSING_SCORE;
    harness.createAgentHandle = async ({ name }) => ({
      name,
      sendTurn: async (prompt) => {
        if (flow.isCompileAgent(name)) {
          compilePrompts.push(prompt);
          // The agent does what it was told: the first pass writes the document, the ones after it
          // add to the copy that is already there.
          const prior = await fs.readFile(artifactFile, "utf8").catch(() => null);
          await fs.writeFile(artifactFile, prior === null ? flow.firstDraft : prior + flow.append, "utf8");
          if (flow.companion) {
            const c = flow.companion(volDir);
            await fs.writeFile(c.file, c.content, "utf8");
          }
        } else if (name.startsWith("validator-merge-")) {
          await fs.writeFile(validationFile, VALIDATION_REPORT, "utf8");
        } else if (name.startsWith("validator-")) {
          const id = name.split("-").pop();
          await fs.writeFile(path.join(volDir, `${flow.partialPrefix}${id}.md`), VALIDATION_REPORT, "utf8");
        } else if (flow.isFeedbackAgent(name)) {
          await fs.writeFile(artifactFile, await fs.readFile(artifactFile, "utf8"), "utf8");
          if (flow.companion) {
            const c = flow.companion(volDir);
            await fs.writeFile(c.file, c.content, "utf8");
          }
        }
        return { text: "", toolCalls: [{ toolCallId: "1", toolName: "readFile", input: {} }] };
      },
      close: async () => {},
    });

    const ctx = flow.buildCtx({
      installment: "01",
      folderName: "Series(01)",
      isFirst: true,
      previousFolderName: null,
      previousArtifactFile: null,
      volDir,
      artifactFile,
      validationFile,
    });
    await flow.load().runChunkedVolume(ctx);

    assert.strictEqual(
      compilePrompts.length,
      SEGMENTS.length,
      `${flow.label}: every chapter of the first volume got its own compile pass`
    );

    // Chapter 1: there is nothing there yet, and saying so is correct.
    assert.ok(
      compilePrompts[0].includes(flow.createInstruction),
      `${flow.label}: chapter 1 is told to create ${flow.artifactName}: ${compilePrompts[0].slice(0, 400)}`
    );
    assert.ok(
      !compilePrompts[0].includes(flow.amendInstruction),
      `${flow.label}: chapter 1 is not told to amend a document that does not exist`
    );
    assert.ok(
      !compilePrompts[0].includes(flow.indexHeading),
      `${flow.label}: chapter 1 is not handed a map of a document that does not exist`
    );

    // Chapter 2: the document IS there, it was put there by chapter 1, and the agent is told both
    // that it must edit it in place and what is already in it.
    const second = compilePrompts[1];
    assert.ok(
      second.includes(flow.amendInstruction),
      `${flow.label}: chapter 2 is told to amend ${flow.artifactName} in place: ${second.slice(0, 400)}`
    );
    assert.ok(
      !second.includes(flow.createInstruction),
      `${flow.label}: chapter 2 is not told to write a document that is already there whole — that is ` +
        `the instruction that destroys the part of it a cut-off reply did not reach`
    );
    assert.ok(
      !second.includes("writeFile (complete contents), in the exact"),
      `${flow.label}: no whole-file write of the cumulative document is offered to chapter 2`
    );
    assert.ok(
      second.includes(flow.indexHeading) && second.includes(flow.indexLine),
      `${flow.label}: chapter 2 is handed the map of what chapter 1 wrote (${flow.indexLine}): ` +
        `${second.slice(0, 400)}`
    );

    // And the volume's copy is the sum of the chapters, not the last chapter's recollection of it.
    const written = await fs.readFile(artifactFile, "utf8");
    assert.ok(written.includes(flow.firstDraft.trimEnd()), `${flow.label}: chapter 1's section survived chapter 2`);
    assert.ok(written.includes(flow.append.trim()), `${flow.label}: chapter 2's addition is in the document`);
  } finally {
    Object.assign(harness, real);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}


async function main() {
  for (const flow of FLOWS) {
    await runFlow(flow);
    console.log(`${flow.label}: the chapter-by-chapter path seeds, amends, guards, and quarantines`);
    await testFirstVolumeIsToldToAmend(flow);
    console.log(`${flow.label}: the first volume's later chapters are told to amend, and are given the map of what came before`);
  }
}

main().catch((err) => {
  console.error("chunked pre-production test failed:", err.message);
  process.exitCode = 1;
});
