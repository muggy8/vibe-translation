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
    // "the compile pass (chapter ch2) dropped character section(s) that … held"
    guardMessage: /the compile pass \(chapter ch2\) dropped character section\(s\)/,
    isCompileAgent: (name) => /^author-voice-06-ch\d+$/.test(name),
    isFeedbackAgent: (name) => /^feedback-author-/.test(name),
    /** The second document the author passes owe, which the seed does not copy in. */
    companion: (volDir) => ({ file: path.join(volDir, "pov-map.md"), content: POV_MAP }),
    load: () => require("../character-voice"),
    compare: (prev, current) => require("../character-voice").compareVoiceCarryForward(prev, current),
    buildCtx: (p) => ({
      values: {
        INSTALLMENT_NUMBER: "06",
        SOURCE_NAME: "Series",
        SOURCE_LANGUAGE: "Japanese",
        TARGET_LANGUAGE: "English",
      },
      folderName: "Series(06)",
      volumeDir: p.volDir,
      sourceFile: path.join(p.volDir, SEGMENTS[0].file),
      bundle: {
        format: "epub",
        segments: SEGMENTS,
        wholeChars: 200,
        wholePath: path.join(p.volDir, SEGMENTS[0].file),
        sourceFingerprint: "fixture-fingerprint",
      },
      isFirst: false,
      previousFolderName: "Series(05)",
      previousVoiceRefFile: path.join(p.prevDir, "character-voice.md"),
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
    // "the compile pass (chapter ch2) dropped style-guide section(s) that … held"
    guardMessage: /the compile pass \(chapter ch2\) dropped style-guide section\(s\)/,
    isCompileAgent: (name) => /^author-style-06-ch\d+$/.test(name),
    isFeedbackAgent: (name) => /^author-style-feedback-/.test(name),
    companion: null,
    load: () => require("../style-guide"),
    compare: (prev, current) => require("../style-guide").compareStyleCarryForward(prev, current),
    buildCtx: (p) => ({
      values: {
        INSTALLMENT_NUMBER: "06",
        SOURCE_NAME: "Series",
        SOURCE_LANGUAGE: "Japanese",
        TARGET_LANGUAGE: "English",
      },
      folderName: "Series(06)",
      volumeDir: p.volDir,
      sourceFile: path.join(p.volDir, SEGMENTS[0].file),
      bundle: {
        format: "epub",
        segments: SEGMENTS,
        wholeChars: 200,
        wholePath: path.join(p.volDir, SEGMENTS[0].file),
        sourceFingerprint: "fixture-fingerprint",
      },
      isFirst: false,
      previousFolderName: "Series(05)",
      previousStyleGuideFile: path.join(p.prevDir, "style-guide.md"),
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
      label.includes("extract") ? "[]" : PASSING_SCORE;
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
    const ctx = flow.buildCtx({ prevDir, volDir, artifactFile, validationFile });

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

async function main() {
  for (const flow of FLOWS) {
    await runFlow(flow);
    console.log(`${flow.label}: the chapter-by-chapter path seeds, amends, guards, and quarantines`);
  }
}

main().catch((err) => {
  console.error("chunked pre-production test failed:", err.message);
  process.exitCode = 1;
});
