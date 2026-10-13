/**
 * test/test-answer-envelopes.js — the three list-answering read passes ask for their list inside an
 * object, read either form, and still rescue claims out of a half answer.
 *
 * Why this shape exists (measured 2026-10-13 against the endpoint this pipeline is configured against):
 * a `response_format` JSON Schema whose root is `type: "array"` is refused **before the model is asked**
 * — HTTP 400 in 161 ms, 0 tokens, `code: structured_output_failed`, "response_format schema must accept
 * only JSON objects at its root". The three read passes that answer with a list — the glossary term list,
 * the character-voice/POV extraction, the style-construct extraction — therefore cannot declare their
 * answer as itself, and the version of this slice is that they declare it inside an object:
 * `{"terms": […]}`, `{"entries": […]}`, `{"constructs": […]}`.
 *
 * What this file pins, scenario by scenario:
 *
 *   1. **Every parser reads both forms.** The envelope is what the request asks for; the bare array is
 *      what a server that ignores `response_format` still answers in. A stage that can read both is a
 *      stage that does not break when the endpoint changes. One shape table, run through all three
 *      parsers, so the three contracts cannot drift apart silently.
 *   2. **Neither form is invented out of nothing.** An answer that is a lone object, or no JSON at all,
 *      is refused by every one of the three — a parser that returned `[]` for those would turn "the
 *      endpoint answered something odd" into "this volume had nothing new".
 *   3. **The voice reader also reads `{"voice": […], "pov": […]}`**, the shape a model reaches for when a
 *      prompt opens by telling it to produce two outputs.
 *   4. **A truncated envelope still gets its claims rescued.** This is the half that matters most: the
 *      whole point of `character-voice/reading.js`'s tolerant reader is that a chapter's worth of claims
 *      is not thrown away because the closing bracket never arrived, and a half ENVELOPE is a different
 *      shape to rescue from than a half array.
 *   5. **A malformed claim inside a closed envelope** costs that claim and not the chapter.
 *   6. **Every declared shape has an object at its root**, and the array-rooted version of each is
 *      refused by the harness before it is sent.
 *   7. **The voice shape is open and the glossary and style shapes are closed — deliberately**, pinned so
 *      neither drifts into the other. The reasons are in `character-voice/stages.js`; the short version is
 *      that its key inventory cannot be measured (no real answer is on disk) and its own prompt contradicted
 *      itself, and a closed schema there is the one shape that can lose a chapter.
 *   8. **Each stage actually sends its own declared shape** — compared against the module that declares it,
 *      not against a copy.
 *   9. **The three prompt files ask for the envelope** and no longer ask for a bare array, and the voice
 *      prompt's POV key list names the key its own example produces.
 *  10. **The audit's declared-shape guard fires** on an array-rooted declared shape — the check that
 *      replaced `ARRAY_ANSWER_KINDS`, which is now empty and therefore could not have caught anything.
 *
 * Fixtures only. Nothing here reads the real 17 volumes or any file under the series folder
 * (AGENTS.md rule 8, gotcha 69). No real model call: every stage call is stubbed.
 *
 * Run with `npm test`, or standalone: `node test/test-answer-envelopes.js`.
 */

require("./test-home"); // the run's records get a throwaway home (gotcha 69)
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const harness = require("../harness");
const { assertShapeIsExpressible } = harness;
const { parseTerms, termsResponseFormat } = require("../glossary/extract");
const { parseVoiceQuirks, voiceResponseFormat, VOICE_ENTRY_KEYS } = require("../character-voice/stages");
const { parseStyleObservations, styleResponseFormat } = require("../style-guide/amend");
const { parseExtractionAnswer, scanTopLevelObjects } = require("../character-voice/reading");
const { DATA_SHAPE_KINDS, DATA_RESPONSE_FORMATS, declaredShapesAreExpressible } = require("./prompt-audit");

const ROOT = path.join(__dirname, "..");

let checks = 0;
/**
 * @param {boolean|void} condition
 * @param {string} message
 * @returns {void}
 */
function ok(condition, message) {
  checks++;
  assert.ok(condition, message);
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} message
 * @returns {void}
 */
function same(a, b, message) {
  checks++;
  assert.deepStrictEqual(a, b, message);
}

/**
 * Make a throwaway folder holding one chapter file.
 *
 * @param {string} name
 * @returns {{dir: string, chapterFile: string}}
 */
function throwawayVolume(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-client-envelope-${name}-`));
  const series = (process.env.SERIES_LOCATION || "").trim();
  const rel = series ? path.relative(path.resolve(series), dir) : "outside";
  if (rel !== "outside" && (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))) {
    throw new Error(`test fixture folder ${dir} is inside SERIES_LOCATION ${series}`);
  }
  const chapterFile = path.join(dir, "ch0.txt");
  fs.writeFileSync(chapterFile, "山田は会計の人である。\n", "utf8");
  return { dir, chapterFile };
}

/**
 * Run one function with `harness.runOneShot` replaced by a recorder, and restore it afterwards.
 *
 * @param {(request: Object) => string} answer - What the fake endpoint replies.
 * @param {Array<Object>} calls - Every request the stage made lands here.
 * @param {Function} run - The stage call to run.
 * @returns {Promise<*>} Whatever the stage returned.
 */
async function withStubbedModel(answer, calls, run) {
  const real = harness.runOneShot;
  harness.runOneShot = async (request) => {
    calls.push(request);
    return answer(request);
  };
  try {
    return await run();
  } finally {
    harness.runOneShot = real;
  }
}

// ─── Scenario 1 ───────────────────────────────────────────────────────────────

/**
 * One shape table, run through all three parsers.
 *
 * The table is the whole point: the three read passes are three contracts, and the thing that keeps them
 * honest is that the same forms answer all three the same way. A parser that learned only the envelope
 * would break the moment an endpoint ignored `response_format`; a parser that learned only the bare array
 * is the state this slice exists to end.
 *
 * @returns {void}
 */
function scenarioEveryParserReadsBothForms() {
  const term = { term: "会計", rendering: "accounting", note: "A job.", type: "concept", query: "会計" };
  const claim = { type: "voice", character: "山田", quirkType: "pronoun", description: "d", examples: ["x"], notes: "" };
  const construct = { category: "tense", pattern: "である", description: "d", examples: ["x"], frequency: "high", notes: "" };

  /** @type {Array<{name: string, expected: number, text: (item: Object, envelope: Object) => string}>} */
  const forms = [
    { name: "the envelope the request asks for", expected: 1, text: (item, envelope) => JSON.stringify(envelope) },
    { name: "the bare array the prompt asked for until this slice", expected: 1, text: (item) => JSON.stringify([item]) },
    { name: "an envelope inside a markdown fence", expected: 1, text: (item, envelope) => "```json\n" + JSON.stringify(envelope) + "\n```" },
    { name: "a bare array inside a markdown fence", expected: 1, text: (item) => "```json\n" + JSON.stringify([item]) + "\n```" },
    { name: "an envelope with prose on both sides of it", expected: 1, text: (item, envelope) => `Here is what I found:\n${JSON.stringify(envelope)}\nThat is all.` },
    { name: "a bare array with prose on both sides of it", expected: 1, text: (item) => `Here is what I found:\n${JSON.stringify([item])}\nThat is all.` },
    { name: "an empty envelope — the honest 'nothing new' answer", expected: 0, text: (item, envelope) => JSON.stringify({ [Object.keys(envelope)[0]]: [] }) },
    { name: "an empty bare array — the same answer in the old form", expected: 0, text: () => "[]" },
  ];

  const parsers = [
    { label: "parseTerms", parse: parseTerms, item: term, key: "terms" },
    { label: "parseVoiceQuirks", parse: parseVoiceQuirks, item: claim, key: "entries" },
    { label: "parseStyleObservations", parse: parseStyleObservations, item: construct, key: "constructs" },
  ];

  for (const parser of parsers) {
    const envelope = { [parser.key]: [parser.item] };
    for (const form of forms) {
      const text = form.text(parser.item, envelope);
      let parsed = null;
      let failure = null;
      try {
        parsed = parser.parse(text);
      } catch (err) {
        failure = err.message;
      }
      ok(parsed !== null, `${parser.label} refused "${form.name}": ${failure}`);
      same(parsed === null ? -1 : parsed.length, form.expected, `${parser.label} read the wrong number of entries from "${form.name}"`);
    }
    // The entry itself survives the round trip.
    const parsed = parser.parse(JSON.stringify(envelope));
    same(parsed.length, 1, `${parser.label} lost the entry carried in its own envelope`);
  }

  console.log("1/10: all three parsers read the envelope and the bare array, fenced or surrounded by prose, empty or not");
}

// ─── Scenario 2 ───────────────────────────────────────────────────────────────

/**
 * An answer that is neither form is refused, not read as "nothing new".
 *
 * `[]` is the honest answer for a volume with nothing new. A lone object, or a reply with no JSON in it,
 * is a different fact, and every one of these three parsers has to tell them apart or the stage files an
 * empty artifact and reports it as a clean volume.
 *
 * @returns {void}
 */
function scenarioNeitherFormIsInventedOutOfNothing() {
  const refusals = [
    { label: "parseTerms", parse: parseTerms, text: '{"term":"会計"}' },
    { label: "parseTerms", parse: parseTerms, text: "no json here" },
    { label: "parseVoiceQuirks", parse: parseVoiceQuirks, text: '{"type":"voice"}' },
    { label: "parseVoiceQuirks", parse: parseVoiceQuirks, text: "no json here" },
    { label: "parseStyleObservations", parse: parseStyleObservations, text: '{"category":"tense"}' },
    { label: "parseStyleObservations", parse: parseStyleObservations, text: "no json here" },
  ];
  for (const item of refusals) {
    let thrown = null;
    try {
      const out = item.parse(item.text);
      thrown = new Error(`returned ${JSON.stringify(out)} instead of refusing`);
    } catch (err) {
      thrown = err;
    }
    ok(thrown !== null, `${item.label} accepted "${item.text}" — an unreadable answer must not look like an empty volume`);
    ok(/No JSON array/.test(thrown.message), `${item.label}'s refusal does not name what it looked for: ${thrown.message}`);
  }
  // An empty envelope is NOT a refusal, and that is the pair this scenario is about.
  same(parseTerms('{"terms": []}'), [], "an empty term envelope was refused — it is the honest 'nothing new' answer");
  same(parseVoiceQuirks('{"entries": []}'), [], "an empty claim envelope was refused");
  same(parseStyleObservations('{"constructs": []}'), [], "an empty construct envelope was refused");

  console.log("2/10: a lone object or no JSON is refused by all three, and an empty envelope is not");
}

// ─── Scenario 3 ───────────────────────────────────────────────────────────────

/**
 * The voice reader also reads the two-array answer a model writes when it takes "produce two outputs"
 * literally.
 *
 * `system-prompts/character-voice-extract.md` opens by telling the model its job is to produce two outputs.
 * The request asks for one array under `entries`; a server that ignores the request can still answer in two
 * arrays. Concatenated in `voice`-then-`pov` order, because nothing downstream cares which array a claim
 * came out of — only which `type` it carries.
 *
 * @returns {void}
 */
function scenarioTheSplitAnswerIsReadToo() {
  const text = JSON.stringify({
    voice: [{ type: "voice", character: "山田", quirkType: "pronoun", description: "d", examples: [], notes: "" }],
    pov: [{ type: "pov", povCategory: "marker", marker: "※", description: "d", examples: [], notes: "" }],
  });
  const parsed = parseVoiceQuirks(text);
  same(parsed.length, 2, "the split voice/pov answer was not read as two claims");
  same(parsed.map((e) => e.type), ["voice", "pov"], "the split answer did not keep voice-then-pov order");
  // Half of it is still half of it: a split answer missing one array yields the other.
  const half = parseVoiceQuirks('{"pov": [{"type":"pov","povCategory":"marker","marker":"※"}]}');
  same(half.length, 1, "a split answer holding only the pov array lost that array");

  console.log("3/10: the voice reader also reads {\"voice\": […], \"pov\": […]}, in order");
}

// ─── Scenario 4 ───────────────────────────────────────────────────────────────

/**
 * A truncated envelope still gets its claims rescued, and is still named as cut off.
 *
 * This is the scenario the envelope decision had to answer. `character-voice/reading.js`'s tolerant reader
 * exists because a real volume 02 chapter lost twenty claims to one missing comma, and three of seven
 * chapters came back with the array never reaching its `]`. Wrapping the array in an object changes what a
 * half answer looks like: `{"entries": [{…},{…}` with no closing bracket anywhere. The rescue has to do the
 * same job on that shape — keep the claims that arrived, name the chapter as cut off, and re-read it.
 *
 * @returns {void}
 */
function scenarioATruncatedEnvelopeStillGetsItsClaimsRescued() {
  const whole = '{"entries": [{"type":"voice","character":"山田","quirkType":"pronoun","description":"one","examples":["本文テキスト。"],"notes":""},{"type":"voice","character":"佐藤","quirkType":"catchphrase","description":"two","examples":["だぜ"],"notes":""}]}';
  const clean = parseExtractionAnswer(whole);
  same(clean.entries.length, 2, "a whole envelope did not parse cleanly");
  same(clean.recovered, false, "a whole envelope went through the tolerant reader");
  same(clean.cutOff, false, "a whole envelope was reported as cut off");

  // The half envelope, cut in the middle of the second claim: the claim that arrived WHOLE is kept, the
  // one that never finished is simply not there, and the chapter is named cut off so it gets its re-read.
  const cutMidClaim = whole.slice(0, whole.lastIndexOf('{"type":"voice","character":"佐藤"') + 60);
  const rescued = parseExtractionAnswer(cutMidClaim);
  same(rescued.recovered, true, "the half envelope did not go through the tolerant reader");
  same(rescued.entries.length, 1, "the claim that DID arrive in the half envelope was thrown away with the one that did not");
  same(rescued.entries[0].character, "山田", "the rescued claim is not the one that arrived whole");
  same(rescued.cutOff, true, "a half envelope was not reported as cut off — the chapter would not be re-read");
  same(rescued.lost.length, 0, "a claim that never arrived is not a lost claim — `cutOff` is what reports it, and the two must not be confused");

  // The half envelope, cut AFTER the last claim closed but before the array did: both claims are kept, and
  // the chapter is still cut off, because whatever the model was about to write is not in the answer.
  const cutAfterLast = whole.slice(0, whole.length - 2);
  const rescuedBoth = parseExtractionAnswer(cutAfterLast);
  same(rescuedBoth.entries.length, 2, "a half envelope that lost no claim threw the claims away anyway");
  same(rescuedBoth.cutOff, true, "an answer whose claim array never closed was not reported as cut off");

  // The scan's own answer, pinned separately: `closed` is about the CLAIM ARRAY, not the envelope.
  const scan = scanTopLevelObjects(cutMidClaim);
  same(scan.closed, false, "scanTopLevelObjects called a half envelope closed");
  same(scan.objects.length, 1, "scanTopLevelObjects did not find the claim that balanced inside the half envelope");

  // The envelope's own brace missing is NOT a cut-off: no claim was lost, so no paid read is spent and no
  // INCOMPLETE row is printed for a chapter that is whole.
  const missingOuterBrace = '{"entries": [{"type":"voice","character":"山田","quirkType":"pronoun","description":"one","examples":[],"notes":""}]';
  const scan2 = scanTopLevelObjects(missingOuterBrace);
  same(scan2.closed, true, "an envelope missing only its outer brace was called cut off — it lost no claim");
  same(scan2.objects.length, 1, "an envelope missing only its outer brace lost its claim");
  const rescued2 = parseExtractionAnswer(missingOuterBrace);
  same(rescued2.entries.length, 1, "the claims of an envelope missing its outer brace were thrown away");
  same(rescued2.cutOff, false, "a chapter that lost no claim was reported as cut off");
  same(rescued2.lost.length, 0, "a chapter that lost no claim reported a lost claim");

  // An envelope cut before it ever reached the array.
  const beforeArray = parseExtractionAnswer('{"entries": ');
  same(beforeArray.entries.length, 0, "an answer with no array produced claims out of nowhere");
  same(beforeArray.cutOff, true, "an answer with no array was not reported as cut off");

  console.log("4/10: a truncated envelope keeps the claims that arrived, names the chapter cut off, and a missing outer brace does neither");
}

// ─── Scenario 5 ───────────────────────────────────────────────────────────────

/**
 * One malformed claim inside a closed envelope costs that claim and not the chapter.
 *
 * The real volume 02 chapter ch2 closed its array cleanly and still lost one claim to a missing comma.
 * Under the envelope the same defect has to behave the same way: the rest of the chapter survives, the
 * broken claim is kept as raw text in the partial, and `cutOff` stays false — while `lost.length > 0` is
 * what makes `reading.js` spend the chapter's second paid read on it.
 *
 * @returns {void}
 */
function scenarioAMalformedClaimInsideAnEnvelopeCostsOnlyItself() {
  const malformed =
    '{"entries": [{"type":"voice","character":"山田","quirkType":"pronoun","description":"one","examples":[],"notes":""},' +
    '{"type":"voice","character":"佐藤" "quirkType":"catchphrase","description":"broken","examples":[],"notes":""},' +
    '{"type":"pov","povCategory":"marker","marker":"※","description":"three","examples":[],"notes":""}]}';
  const out = parseExtractionAnswer(malformed);
  same(out.entries.length, 2, "a closed envelope with one malformed claim lost the two claims that were fine");
  same(out.cutOff, false, "an answer that closed its array was reported as cut off");
  same(out.recovered, true, "the tolerant reader did not run on a malformed claim");
  same(out.lost.length, 1, "the malformed claim was not named");
  ok(out.lost[0].raw.includes("佐藤"), `the lost claim was recorded without its own text: ${out.lost[0].raw}`);
  ok(out.lost[0].because.length > 0, "the lost claim was recorded without a reason");

  console.log("5/10: one malformed claim inside a closed envelope costs that claim, names it, and does not call the chapter cut off");
}

// ─── Scenario 6 ───────────────────────────────────────────────────────────────

/**
 * Every shape this repository declares has an object at its root, and the array-rooted version of each is
 * refused before it is ever sent.
 *
 * @returns {void}
 */
function scenarioEveryDeclaredShapeIsExpressible() {
  const declared = {
    "glossary-extract": termsResponseFormat(),
    "voice-extract": voiceResponseFormat(),
    "style-extract": styleResponseFormat(),
    "glossary-research": require("../glossary/research").researchResponseFormat(),
  };
  for (const [kind, shape] of Object.entries(declared)) {
    let accepted = true;
    try {
      assertShapeIsExpressible(shape, kind);
    } catch (err) {
      accepted = false;
      ok(false, `${kind}'s declared shape was refused by the harness: ${err.message}`);
    }
    ok(accepted, `${kind}'s declared shape is not one this endpoint can be given`);
    same(shape.type, "json_schema", `${kind} does not declare a json_schema`);
    same(shape.json_schema.schema.type, "object", `${kind}'s shape does not have an object at its root`);

    // The same list rooted on an array — the request that cost HTTP 400 and 0 tokens on 2026-10-13.
    const arrayRooted = {
      type: "json_schema",
      json_schema: { name: `${kind}_array`, schema: { type: "array", items: shape.json_schema.schema.properties } },
    };
    let refused = false;
    try {
      assertShapeIsExpressible(arrayRooted, kind);
    } catch (err) {
      refused = /root is "array"/.test(err.message);
    }
    ok(refused, `${kind}: an array-rooted version of its own shape was not refused before it was sent`);
  }

  console.log("6/10: all four declared shapes have an object root, and the array-rooted version of each is refused");
}

// ─── Scenario 7 ───────────────────────────────────────────────────────────────

/**
 * The voice shape is open and the glossary and style shapes are closed, and that difference is pinned.
 *
 * Three separate contracts, three different levels of looseness, and the reason each one has is in the
 * module that declares it. What this scenario refuses is drift: a later edit that "tidies" the voice shape
 * into the closed shape of its neighbours would be an edit that can cost a chapter's worth of claims, and
 * nothing else in the tree would notice.
 *
 * @returns {void}
 */
function scenarioTheThreeShapesAreDifferentOnPurpose() {
  const glossaryItem = termsResponseFormat().json_schema.schema.properties.terms.items;
  const styleItem = styleResponseFormat().json_schema.schema.properties.constructs.items;
  const voiceItem = voiceResponseFormat().json_schema.schema.properties.entries.items;

  same(glossaryItem.additionalProperties, false, "the glossary entry shape is no longer closed");
  same(styleItem.additionalProperties, false, "the style entry shape is no longer closed");
  ok(voiceItem.additionalProperties === undefined,
    "the voice entry shape gained additionalProperties — it is open on purpose (see character-voice/stages.js); " +
      "a closed schema there is the one shape that can lose a chapter's worth of claims");
  ok(voiceResponseFormat().json_schema.strict === undefined,
    "the voice shape gained `strict` — strict is a promise that the schema is closed, and this one is not");

  // The voice inventory is the prompt's own keys, and the key its own example produced is among them.
  for (const key of ["type", "character", "quirkType", "description", "examples", "formalityLevel", "notes",
    "povCategory", "marker", "assignedCharacter", "narrationType", "sectionDescription"]) {
    ok(VOICE_ENTRY_KEYS.includes(key), `the voice key inventory no longer names "${key}"`);
    ok(Object.prototype.hasOwnProperty.call(voiceItem.properties, key), `the voice shape does not declare "${key}"`);
  }
  same(voiceItem.required, ["type"], "the voice entry shape changed what it requires");
  same(glossaryItem.required, ["term", "rendering", "note", "type", "query"], "the glossary entry shape changed what it requires");
  same(styleItem.required, ["category", "pattern", "description", "examples", "frequency", "notes"], "the style entry shape changed what it requires");

  console.log("7/10: the voice shape is open and the glossary and style shapes are closed, and the difference is pinned");
}

// ─── Scenario 8 ───────────────────────────────────────────────────────────────

/**
 * Each stage sends the shape its own module declares — compared against the module, not against a copy.
 *
 * @returns {Promise<void>}
 */
async function scenarioEachStageSendsItsOwnShape() {
  const voiceStage = require("../character-voice/stages");
  const styleStages = require("../style-guide/stages");
  const { extractChapterTerms } = require("../glossary/chunked");

  // ── character-voice ─────────────────────────────────────────────────────────
  const voice = throwawayVolume("voice");
  const voiceCtx = {
    values: { INSTALLMENT_NUMBER: "01", SERIES_NAME: "Test Story" },
    volumeDir: voice.dir,
    bundle: { segments: [{ id: "ch0", file: "ch0.txt", title: "プロローグ" }], wholeChars: 20, sourceFingerprint: "fixture" },
    extractSystemPrompt: "You are a **Voice and Perspective Analyst**.",
    extractPrompt: "Volume being processed: 01",
    previousVoiceRefFile: null,
  };
  /** @type {Array<Object>} */
  const voiceCalls = [];
  await withStubbedModel(() => '{"entries": []}', voiceCalls, () =>
    voiceStage.runExtract(voiceCtx, voiceCtx.bundle.segments[0], 0, { stateFile: null })
  );
  same(voiceCalls.length, 1, "the voice extraction made the wrong number of calls");
  same(JSON.stringify(voiceCalls[0].responseFormat), JSON.stringify(voiceResponseFormat()),
    "the voice extraction did not send the shape its own parser declares");

  // ── style-guide: the whole-volume branch and the chapter branch ─────────────
  const style = throwawayVolume("style");
  const styleCtx = {
    values: { INSTALLMENT_NUMBER: "01", SERIES_NAME: "Test Story" },
    volumeDir: style.dir,
    sourceFile: style.chapterFile,
    bundle: { segments: [{ id: "ch0", file: "ch0.txt", title: "プロローグ" }], wholeChars: 20, sourceFingerprint: "fixture" },
    extractSystemPrompt: "You are a **Style Convention Analyst**.",
    extractPrompt: "Volume being processed: 01",
    previousStyleGuideFile: null,
    styleOutputFile: path.join(style.dir, "style-guide.md"),
  };
  /** @type {Array<Object>} */
  const styleCalls = [];
  await withStubbedModel(() => '{"constructs": []}', styleCalls, () => styleStages.runExtract(styleCtx));
  await withStubbedModel(() => '{"constructs": []}', styleCalls, () =>
    styleStages.runExtract(styleCtx, styleCtx.bundle.segments[0], 0)
  );
  same(styleCalls.length, 2, "the style extraction made the wrong number of calls");
  for (const call of styleCalls) {
    same(JSON.stringify(call.responseFormat), JSON.stringify(styleResponseFormat()),
      "a style extraction branch did not send the shape its own parser declares");
  }

  // ── glossary: the chapter pass ──────────────────────────────────────────────
  const glossary = throwawayVolume("glossary");
  const glossaryCtx = {
    values: { INSTALLMENT_NUMBER: "01", SERIES_NAME: "Test Story" },
    folderName: path.basename(glossary.dir),
    seriesDir: path.dirname(glossary.dir),
    volumeDir: glossary.dir,
    bundle: { segments: [{ id: "ch0", file: "ch0.txt", title: "プロローグ" }], wholeChars: 20, sourceFingerprint: "fixture" },
    glossaryOutputFile: path.join(glossary.dir, "glossary.md"),
    previousGlossaryFile: null,
    termsPrompt: "Volume being processed: 01",
    termsSystemPrompt: "You are a **Terminology Extraction Specialist**.",
    extractionReads: [],
  };
  /** @type {Array<Object>} */
  const glossaryCalls = [];
  await withStubbedModel(() => '{"terms": []}', glossaryCalls, () =>
    extractChapterTerms(glossaryCtx, glossaryCtx.bundle.segments[0], 0)
  );
  same(glossaryCalls.length, 1, "the glossary chapter pass made the wrong number of calls");
  same(JSON.stringify(glossaryCalls[0].responseFormat), JSON.stringify(termsResponseFormat()),
    "the glossary chapter pass did not send the shape its own parser declares");

  console.log("8/10: the voice, style (both branches) and glossary chapter passes each send their own declared shape");
}

// ─── Scenario 9 ───────────────────────────────────────────────────────────────

/**
 * The three prompt files ask for the envelope, and the voice prompt's own contradiction is closed.
 *
 * The prompt audit can only keep a prompt honest if the prompt says what the schema asks for. A file that
 * still told the model to answer with a bare array beside a request for an object would be a contract that
 * fails at the endpoint and looks correct in the diff.
 *
 * @returns {void}
 */
function scenarioThePromptsAskForTheEnvelope() {
  const files = [
    { file: "glossary-terms.md", key: "terms" },
    { file: "character-voice-extract.md", key: "entries" },
    { file: "style-guide-extract.md", key: "constructs" },
  ];
  for (const { file, key } of files) {
    const text = fs.readFileSync(path.join(ROOT, "system-prompts", file), "utf8");
    ok(!/Respond with \*\*only\*\* a JSON array/.test(text), `${file} still asks for a bare JSON array`);
    ok(!/respond with an empty JSON array/.test(text), `${file} still tells the model to answer an empty array`);
    ok(new RegExp(`Respond with \\*\\*only\\*\\* a JSON object holding one key, \`${key}\``).test(text),
      `${file} does not ask for the \`${key}\` envelope its schema declares`);
    ok(new RegExp(`\\{"${key}": \\[]\\}`).test(text), `${file} does not say what the "nothing new" answer looks like`);
    const fences = (text.match(/```/g) || []).length;
    same(fences % 2, 0, `${file} has an unclosed markdown fence (${fences} fence markers) — the model is shown an unterminated example`);
  }

  // The voice prompt's own contradiction: its POV element block used to omit the key its own example produced.
  const voice = fs.readFileSync(path.join(ROOT, "system-prompts", "character-voice-extract.md"), "utf8");
  const povBlock = voice.slice(voice.indexOf('For **POV analysis**:'), voice.indexOf("If there is **nothing new"));
  ok(povBlock.includes('"description"'),
    "the voice prompt's POV key block no longer names `description`, the key its own example produces — the " +
      "contradiction this slice closed");
  ok(povBlock.includes('"sectionDescription"'), "the voice prompt's POV key block lost `sectionDescription`");
  // Every key the example answer produces is a key the prompt names.
  const example = voice.slice(voice.indexOf("Example shape (do not copy these values):"));
  for (const key of ["type", "povCategory", "marker", "description", "character", "quirkType", "examples", "formalityLevel", "notes"]) {
    ok(example.includes(`"${key}"`), `the voice prompt's example no longer produces "${key}"`);
    ok(VOICE_ENTRY_KEYS.includes(key), `the voice prompt's example produces "${key}", which the declared inventory does not hold`);
  }

  console.log("9/10: all three prompts ask for their envelope, close their fences, and the voice prompt names the key its own example produces");
}

// ─── Scenario 10 ──────────────────────────────────────────────────────────────

/**
 * The audit's declared-shape guard fires on an array-rooted declared shape.
 *
 * `ARRAY_ANSWER_KINDS` — the set that used to fail any list-answering call that sent a shape — is empty
 * now that all three send one, and an empty set is a check that never runs. What replaced it asks a question
 * about the DECLARED shapes, so it fires on a schema nobody has run yet. This scenario plants the exact
 * request that cost HTTP 400 and 0 tokens on 2026-10-13 and asserts the guard names it.
 *
 * @returns {void}
 */
function scenarioTheAuditRefusesAnArrayRootedDeclaredShape() {
  same([...DATA_SHAPE_KINDS].sort(), ["glossary-extract", "glossary-research", "style-extract", "voice-extract"],
    "the set of data-shaped calls is not the four this repository declares");
  same(Object.keys(DATA_RESPONSE_FORMATS).sort(), [...DATA_SHAPE_KINDS].sort(),
    "DATA_RESPONSE_FORMATS and DATA_SHAPE_KINDS disagree — a data-shaped call with no declared shape");
  same(declaredShapesAreExpressible(DATA_RESPONSE_FORMATS), [],
    "a declared shape is not one this endpoint can be given");

  const planted = {
    "glossary-extract": {
      type: "json_schema",
      json_schema: { name: "glossary_new_terms", strict: true, schema: { type: "array", items: { type: "object" } } },
    },
    "voice-extract": { type: "json_object" },
  };
  const gaps = declaredShapesAreExpressible(planted);
  same(gaps.length, 2, `the declared-shape guard reported ${gaps.length} of the 2 planted shapes`);
  ok(gaps.some((g) => g.includes("glossary-extract") && g.includes('root "array"')),
    `the guard did not name the array-rooted shape: ${gaps.join(" | ")}`);
  ok(gaps.some((g) => g.includes("voice-extract")), `the guard did not name the shapeless call: ${gaps.join(" | ")}`);

  console.log("10/10: the audit's declared-shape guard names an array-rooted shape and a shapeless data call");
}

// ─── Run ──────────────────────────────────────────────────────────────────────

(async () => {
  scenarioEveryParserReadsBothForms();
  scenarioNeitherFormIsInventedOutOfNothing();
  scenarioTheSplitAnswerIsReadToo();
  scenarioATruncatedEnvelopeStillGetsItsClaimsRescued();
  scenarioAMalformedClaimInsideAnEnvelopeCostsOnlyItself();
  scenarioEveryDeclaredShapeIsExpressible();
  scenarioTheThreeShapesAreDifferentOnPurpose();
  await scenarioEachStageSendsItsOwnShape();
  scenarioThePromptsAskForTheEnvelope();
  scenarioTheAuditRefusesAnArrayRootedDeclaredShape();
  console.log(`OK: ${checks} checks on the three read passes' answer envelopes.`);
})().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
