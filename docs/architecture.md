# Architecture

How a task runs: the harness primitives, the provider plumbing, the shared QA-loop shape, series intake, the source bundle, the processing-mode decision, and the per-machine hooks.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

## 3. Architecture

### harness.js primitives (the only way to talk to the model)

- **`runOneShot({ systemPrompt, messages, ... })`** — one tool-less call. `messages` are `{ text }` or `{ file, name }` (images/wav/mp3 become binary parts; undetectable types are inlined as text). Streaming with a non-streaming fallback; retries empty/error responses up to `AI_RETRY`; an idle deadline (`AI_CALL_DEADLINE_MS`, default 60 min, `0` = off) aborts an attempt that makes no progress (an IDLE timeout reset on every event, so healthy long calls are never aborted — all fetch timeouts are disabled, so this is the only wall-clock bound); **throws on empty — it never returns `""`** (workflows persist the returned string verbatim, so an empty result must fail the run instead of corrupting an artifact).
- **`createAgentHandle({ name, systemPrompt, tools, approve, cwd, maxSteps, contextManagement, ... })`** — a tool-using agent backed by an OpenHarness `Session`, with retry-with-backoff. **Auto-compaction is off on every handle** (`autoCompact: false`): the library's compaction is a lossy summary of the agent's own conversation, and it used to fire silently inside stage turns — which is how "the agent quietly stopped honoring the honorific rules" first showed up, as a worse artifact and no error (gotcha 56). With it off, the server decides: a request that genuinely does not fit comes back as the tagged `tooBigForOnePassError` the whole-installment → chapter-by-chapter fallback repairs. `sendTurn()` keeps message history across turns (author sessions reuse one session for generation + all feedback passes). For writing agents an empty final chat reply is *success* (the output went to disk) — no empty-retry there. `contextManagement: true` is the delivery layer's opt-in to the uncapped, offloading turn — see docs/delivery-layer.md "Uncapped turns" and gotcha 78.
- **`createWikiTools()`** — `wiki_search(query, lang?)` / `wiki_extract(title, lang)` backed by research.js.
- **`createGatedFsTools({ cwd, allowedDirs })`** — OpenHarness fs tools (**readFile / listFiles / grep / writeFile / editFile** — `deleteFile` is not offered at all, see gotcha 8) with an **approve gate**: reads always allowed, `writeFile`/`editFile` confined to `allowedDirs` (the volume folder), `deleteFile` refused outright if anything still reaches for it. This is the sandbox — do not weaken it. The read caps are raised from the library defaults (2000 chars/line, 32 KB/read) to `AGENT_MAX_LINE_LENGTH` (8000) and `AGENT_MAX_READ_BYTES` (65536): the cumulative artifacts hold lines longer than the default cap, so an agent that cannot read what it is required to preserve starts reconstructing it from memory (gotcha 58). The tools are then **re-described and input-normalized** (`applyFsToolContract`) so they match how a model actually reaches for them — grep/listFiles take a **folder** (a file passed as `dirPath` is turned into its folder plus a file-scoped search, instead of crashing with `ENOTDIR`), grep's `glob` is a **filename ending** (a `*` the model writes is stripped instead of silently matching nothing), an uncompilable regex is answered with the flag the tool actually has, and an archive is refused as text (the library's binary list does not know `.epub`). See gotcha 60. The normalization runs INSIDE the approve gate, so a repaired path can never slip past a gate that judged the agent's original one.
- **`createEpubTools({ cwd, allowedDirs, sampleChars })`** — the intake agent's senses: `epubInfo(filePath)` (the book's catalog card + section list), `readEpubText(filePath, section, offset, limit)` (a bounded plain-text slice, capped per call so 17 books cannot blow the context window), `stageVolume({sourceFile, folder, as})` (create the volume folder and put the source in it — **a relative shortcut to the original, not a second copy**; the original is never touched, identical re-staging is a no-op, a different file is never clobbered, **a shortcut that points at a missing file is refused rather than written through**, a filesystem that cannot link falls back to a copy and says so, one folder level only). Its approve gate confines staging to `allowedDirs` and denies `deleteFile`. The intake composes it with the fs gate through `createIntakeApprove` (AND of both gates, **plus a refusal of readFile/grep/writeFile/editFile on `.epub`/`.zip` paths** — the plain file tools are text tools, so a book is read through the epub tools or not at all, and a book file can never be overwritten).

### Provider plumbing (local-LLM friendly)

- ESM bridge: `@openharness/core` + `@ai-sdk/openai` ship ESM-only builds; loaded lazily via `loadEsm()` (this project is CommonJS).
- Custom fetch built on **undici's own `fetch` + a no-timeout `Agent` from the same undici build** (all timeouts disabled — local servers can prefill for minutes); never mix the Agent with Node's *global* fetch — that crosses undici versions and throws `invalid onRequestStart method` on some Node builds (gotcha 19); merges thinking params into the request body (`chat_template_kwargs` for Qwen3-style models, `reasoning_effort` for levels); taps SSE/JSON responses for `reasoning_content` + first-token timing diagnostics.
- Every call logs to stderr **and** `.logs/call-ai-<timestamp>.log` (CALL/RESULT lines: finish reason, content/reasoning sizes, token usage, TTFT, tok/s). Workflow logging goes through `harness.logLine`.

### Shared workflow shape (all four volume tasks)

1. Read the plan of record — the translation-target manifest (`getTranslationTarget()`, produced by the intake step; see docs/architecture.md.5). It gives, in reading order, each volume's folder, its staged source file, the series name, and the source language. Series name / source language / target language are then resolved per run by `resolveRunSettings(manifest)` (.env override > manifest > default). With `--dry-run` a deterministic fallback builds the manifest instead, so prompt previews stay fully offline.
2. Fill `{{PLACEHOLDER}}`s in the user-prompt templates (`transformUserPrompt` — **strict**: throws on a missing value or any leftover placeholder).
3. **QA loop** per volume, up to `QA_MAX_ITERATIONS`: score-based
   acceptance — the acceptance one-shot check (tool-less) sees the audited
   artifact(s) **and** the validation report (the report is a guide; the
   artifact is what gets judged), samples like a grader (`JUDGE_TEMPERATURE`
   + `STAGE_THINKING_LEVEL`, not the authoring settings — gotcha 59), and
   scores the artifact **0–100**
   (100 = perfect, 0 = atrocious) using a banded rubric in the
   `*-acceptance.md` system prompts (Pass → 85–100, Pass with minor
   edits → 70–84, Requires revision → 40–69, Reject → 0–39), replying as
   a single JSON object (`{"score", "band", "note"}`). Each score is
   tracked in a rolling window (`ACCEPTANCE_WINDOW_SIZE`, default 2). When the
   window meets the criterion from `meetsAcceptanceCriteria()` (default
   strategy `average`: rolling average of scores ≥ `PASSING_SCORE`,
   default 70; alternative `best`: at least `ACCEPTANCE_BEST_MIN_PASSES` of the
   scores ≥ the passing score) **and no single score in the window is below
   `ACCEPTANCE_SAMPLE_FLOOR`** (default `PASSING_SCORE − 15`; `0` restores pure
   averaging) and the window is full (it needs
   `min(2, ACCEPTANCE_WINDOW_SIZE)` checks — derived, not a separate knob), the
   output is accepted. The floor is what stops an average from laundering a
   rejection: with a window of 2 and a passing score of 69, scores of `[100, 38]`
   used to accept an artifact one grader had called *atrocious* because the other
   one loved it. An unparseable acceptance
   reply counts as a failed check (fail-closed) and is not stored. Otherwise,
   feedback is applied and the loop continues. A passing output
   is never touched by a feedback pass. The loop mechanics (rolling window,
   state persistence, criterion check, recovery gating, the passing-grade
   re-grade, the no-op feedback stop, `ON_QA_LIMIT` policy)
   run through the shared loop in `utils/qa-loop/whole.js`; each task injects only
   its validator, acceptance check, feedback stage, feedback artifact list, and
   log lines. The four
   CHUNKED (chapter-by-chapter) loops are the SAME loop with per-chapter stages —
   `utils/qa-loop/chunked.js` — so the grading half, the consensus gates, the
   no-op check and the `ON_QA_LIMIT` policy are one implementation for both modes
   rather than two that have to be kept in step. A task supplies three stage
   descriptions (validator / findings-merge / feedback: what to say, to whom, and
   what each must leave on disk) plus its grader and its log lines.

   **A passing grade earns its remaining samples by re-grading, not by
   rewriting** (`confirmPassingScore`, `ACCEPTANCE_CONFIRM_ON_PASSING`, default
   ON). The window needs `min(2, ACCEPTANCE_WINDOW_SIZE)` scores before it can
   accept, so a first grade of 76 against a passing score of 69 cannot accept
   yet — and the only route the loop had to the second sample was: rewrite the
   artifact, re-audit it from scratch, grade again. Measured on the live
   17-volume run for volume 01's character voice reference, that cost **2.63M
   tokens for a feedback pass that wrote nothing** (46 tool calls: 29 reads, 15
   searches, zero writes) plus **8.4M tokens** for the validator turn that graded
   a document which had not changed. A grade is a tool-less one-shot over files
   already on disk — about 55k tokens. So when the window is short AND the grade
   just obtained already clears both the passing score and the sample floor, the
   loop takes the remaining samples from the SAME artifact — the first at the
   normal judging temperature (a genuinely independent second opinion), the last
   at temperature 0 (the deterministic anchor) — and puts them INTO the window,
   because collecting them is the whole point. If any of them fails, the window
   says so and the caller runs the feedback round it was going to run anyway: a
   grader that disagrees with a passing grade is exactly the signal that wants a
   rewrite. It is deliberately NOT a lower copy of the exceptional path — that
   one asks "is this great grade real?" and keeps its confirmations OUT of the
   window, because a failed consensus must lead to the ordinary loop, not to an
   acceptance built from the grades that just failed. This one is filling the
   window, so its grades belong in it (`acceptedBy: "passing-consensus"`).

   **A feedback pass that changed nothing ends the loop** (`fingerprintFiles` in
   utils/fs.js). Every existing check asks "is the file there?"; none asked "did
   this pass do anything?", and that is the hole the 46-tool-call zero-write turn
   fell into: both artifacts existed and were real, so `assertWroteWithFallback`
   reported no gap, no recovery turn ran, `assertRealOutput` passed, and the loop
   cheerfully started another iteration. The loop now hashes the artifacts
   `cfg.feedbackArtifactFiles` names before `runFeedback` and again after it;
   byte-identical means the pass produced nothing, so it logs loudly, records
   `stalled: true` in the state file, and stops rather than paying for another
   validator turn and another grade over an unchanged document. `ON_QA_LIMIT`
   then decides accept-or-fail, exactly as at the iteration limit. The two rules
   compose: with the re-grade path in place, the stall only fires when the grades
   genuinely disagree — which is when a rewrite was the right answer anyway.
   **Fresh agent per feedback iteration** for glossary / character-voice /
   style-guide (no persistent session — each feedback turn starts with a
   clean context that includes the validation report and the current
   artifact); the wiki keeps its author session for feedback.
4. **Idempotency**: a volume whose outputs already exist and pass acceptance is skipped (unless `--force`). The skip-check reads a persisted rolling-window state file (`*-rolling-state.json`) written alongside the validation report during the last run, recomputing the acceptance decision deterministically — no AI call needed. If the state file is missing or corrupt, the check falls back to regenerating (fail-open). A failed skip-check degrades to "not skipped" (fail-open, by design). **Source-staleness detection**: the state file also persists the `sourceFingerprint` of the source file the accepted output was built from (sha256 of the original plain-text file, or the epub extraction cache hash — `bundle.sourceFingerprint` from `utils/source.js`). On re-run, `isSourceStale(state, bundle)` compares the two: a changed source invalidates the skip and the volume regenerates (then the cumulative `regeneratedAny` cascade rebuilds all later volumes). Fail-open: a legacy state file without a fingerprint, or a bundle without one, keeps the current skip behavior — old runs are safe to re-run.

**Un-monitored run policies** (front-loaded in `.env`, see docs/environment.md): the pipeline is built to run un-monitored overnight / for multiple days, so the decisions that would otherwise need a human are env-driven (code defaults keep the safe "fail loudly" behavior):

- `validateRequiredEnv({ dryRun })` (configs/shared.js) runs at the top of every task and fails fast with a single message naming every missing required variable (`SERIES_LOCATION`, and `AI_API_KEY` for live runs — `SERIES_NAME` is never required, the intake step decides it, see docs/architecture.md.5) — a misconfigured `.env` is caught at run start, not hours in.
- `ON_VOLUME_ERROR` (`abort` default / `skip`): when a volume's processing throws, the per-volume body of each task is wrapped in a try/catch — `skip` records the volume and continues with the next one (in the cumulative tasks the next volume then misses its previous artifact and is skipped in turn by `ON_MISSING_PREVIOUS=skip`, cascading to the end of the task). **Skipping is not succeeding:** every task ends by calling `volumeFailureError(taskName, failedVolumes, totalVolumes)` (configs/shared.js) and throws it, so a task that skipped volumes fails the run with a named summary. A `structuralError` is never skippable — the catch rethrows it whatever the policy says.
- `ON_MISSING_PREVIOUS` (`abort` default / `skip`): replaces the "process the earlier volume first" throw in the three cumulative tasks with an optional warn-and-skip.
- `ON_QA_LIMIT` (`accept` default / `fail`): when the QA loop hits `QA_MAX_ITERATIONS` without a passing grade — accept the output as-is (legacy) or fail the volume.
- `ON_TASK_ERROR` (`abort` default / `continue`): in the default run, a failing step either stops the run (gulp `series` behavior) or the remaining steps still run and the run fails at the end with a summary of all failed steps (`runPipeline()` in gulpfile.js). A `structuralError` is never continued past, whatever the policy says — the remaining steps are guaranteed to fail on the same missing foundation, and each attempt costs a model container switch (observed live: a rejected intake plan made all nine steps re-run the intake, three attempts apiece, the last ones against the translator container the `translate` pre-hook had just switched in — which cannot act as a tool-calling agent and answered with nothing).
- `DISCOVER_MAX_ATTEMPTS` (default 2; legacy name `DISCOVERY_MAX_ATTEMPTS` still honored): the intake agent is retried with a fresh agent (10 s apart) when it produces an invalid manifest or references missing source files.

### 3.5 Series intake (`get-translation-target.js`, the `discover` task)

Step 0 of the pipeline. The old behavior — "every volume is a folder named `<Series Name>(NN)` containing one text file" — is replaced by an agent that is handed only `SERIES_LOCATION` and works the rest out by looking at the files.

Flow (`getTranslationTarget()` → `discoverSeries()`):

1. **Reuse or run.** `readUsableManifest()` returns the committed manifest only when it is schema 2, VALIDATES, its `seriesLocation` matches `SERIES_LOCATION`, and every listed source file still exists; anything else — including a half-written file — falls through to a fresh intake run (`--force` always re-runs it). An invalid manifest is never handed downstream (see gotcha 33).
2. **Look.** The agent gets `createGatedFsTools` (reads anywhere under the series dir, writes confined to it) **AND** `createEpubTools` — `epubInfo` (catalog card: title, creator, language, publisher, identifier, the Calibre/EPUB3 series marker, section list, and `contentsList` — the book's own list of its sections, because `readableSections` counts PAGES and a 10-chapter book reports 35 of them, gotcha 52), `readEpubText` (a bounded slice, `DISCOVER_SAMPLE_CHARS`, default 1500, max 6000 per call), `stageVolume`. Step cap scales with the number of entries to look at. The composed gate (`createIntakeApprove`) shuts the plain file tools at `.epub` paths: a book is read with the epub tools, never as text, and never written over.
3. **Decide.** Which files are volumes, in what reading order, which are excluded (art books, previews, duplicates, side stories), the series name (plus an alternate/romanized form), the source language, and the folder name for each volume. For every volume it accepts it also records an `integrity` block — `{ isNarrative, confidence, basis }` — its own judgment of whether the text it read is a **real narrative** (a story, or a legitimate short story), what it read, and how sure it is. A file it does not believe is a story belongs in `discovery.excluded` with a reason, never in `volumes`. It writes `translation-target.json` with `writeFile` and reports `discovery.confidence` + `discovery.evidence` + `discovery.excluded`.
4. **Validate.** `validateManifest` checks the schema, sanitizes each folder name (`sanitizeFolderName` — validated, never rewritten), normalizes installment numbers to `NN`, requires unique folders/installments, requires each volume's `sourceFile` to be the staged book **inside its own folder** (forward slashes are the stored form; the book is usually a shortcut, and the rule is about the NAME being inside the folder — what it reaches is the original at the series root, see gotcha 77), and — via `validateVolumeIntegrity` — requires every volume's `integrity` block to exist, to say `isNarrative` as a real boolean, to carry a `0..1` confidence, and to name a `basis` (a gate the model can pass by saying nothing is not a gate). `findDuplicateSources` then rejects the same book listed as two volumes — the one mistake folder-name freedom makes possible. After validation, `volumeIntegrityProblems` adds the objective half (below). A malformed reply is salvaged from the chat text (`extractJsonObject`); a still-invalid plan triggers a correction turn (the agent is shown its own error, including the duplicate) and then a fresh-agent retry.

   **Objective "is this a book?" cross-check** (`checkVolumeSourceShape`): the agent's judgment is necessary but not sufficient — a model can be wrong about what it read. So each staged file is also checked without any guessing about what a story is: an archive with no readable text section is rejected; a file that yields under `DISCOVER_MIN_VOLUME_TEXT_CHARS` (default 1000) characters is binary junk / an empty archive / a stub; a text file that is mostly undecodable bytes is a binary file renamed; and an archive whose **image payload dwarfs its text payload while its prose is thin** (non-text bytes ≥ 5 MB, ≥ 20× the uncompressed XHTML payload, and under `DISCOVER_ARTBOOK_MAX_TEXT_CHARS` (default 20000) characters of prose) is an art book. The prose is counted ACROSS THE BOOK (the walk stops as soon as the book is clearly a book), and the two payloads are compared in BYTES from the zip's central directory — see gotcha 51. Any failure is a structural problem that fails the intake attempt and feeds the correction turn.
5. **Protect what already exists.** `readCommittedLayout` records every existing folder under the series dir and whether it already holds pipeline output; `applyCommittedLayout` forces the agent to keep such a folder's name (and its staged source) instead of renaming it — renaming would orphan every artifact built under the old name. A disagreement warns and the corrected plan is kept (or the step fails immediately when `DISCOVER_STRICT=true` — a retry cannot make an agent respect a policy).
6. **Gate.** `confidenceGate` refuses to start the pipeline below `DISCOVER_MIN_CONFIDENCE` (default 0.6; 0 disables) — and is **fail-closed**: a plan that reports no `discovery.confidence` at all is rejected, because a gate the model can pass by saying nothing is not a gate. A wrong reading order poisons every cumulative artifact, so an unsure plan stops the run rather than quietly producing 17 wrong glossaries.
7. **Publish.** `translation-target.json` (schema 2) + `translation-plan.md` (the human-readable version: the chosen order, the exclusions with reasons, the evidence). Both live at the series root.

`--dry-run` never calls the model and never writes the plan of record. When a committed plan exists it is **previewed as-is** (nothing is built, nothing is written) — the preview must match what the real run will do. Only when there is no committed plan does `buildDeterministicManifest` lay one out: existing volume folders that hold a book (the legacy `<Series>(NN)` naming and the agent's own folder names/file names), or, if there are none, each loose source file staged into its own numbered folder (staging is the one side effect a dry run has). With no committed plan and no `SERIES_NAME` it names the series itself from the books it found (`deriveSeriesName` — the name the volume titles share), because a preview must not depend on a variable the real run does not need.

Settings precedence is centralized in `resolveRunSettings(manifest)` (configs/shared.js): **`.env` override > manifest > default** for series name, source language and target language. `SERIES_NAME` is never required — unset, the manifest (what the intake agent actually read) decides it.


### Source bundle & chapter-by-chapter fallback (`utils/source.js`)

Every task resolves its volume source through `resolveSourceBundle()` at the choke point (right after manifest discovery). A plain-text source passes through as a single-segment bundle — except an **oversized plain-text source** (bigger than `SOURCE_CHUNK_THRESHOLD_CHARS`) is split into part files (`<base>-part-NN.md`, via `splitPlainTextSegments` + `materializeTextParts`, cached by source fingerprint) so the chapter-by-chapter fallback can process it just like a big epub; an `.epub` is extracted once (jszip + cheerio, cached in `<base>-bundle.meta.json` + per-chapter files) into a `SourceBundle`. **The default processing mode is whole-installment** (the `-whole.md` file); the **chapter-by-chapter fallback** activates when the size check says a whole pass would not fit, or `--chunked` is passed (see "Processing mode" below). Bundle layout in the volume folder:

- `<base>-whole.md` — the full normalized text (what whole-mode stages read)
- `<base>-ch0.md` — prologue; `<base>-ch1..N.md` — chapters; `<base>-chN.1..K.md` — interludes (and epilogues) after chapter N (the counter K restarts at 1 for each chapter; a segment before any chapter is `ch0.K`)
- `images/` — extracted images + `manifest.json`
- `<base>-bundle.meta.json` — extraction cache (epub mtime/hash → skip re-extraction; `--force` re-extracts). Schema 6 adds the **script mix** — CJK characters vs everything else, for the whole installment AND per chapter — because a token count belongs to a (text, MODEL) pair: the mix is a property of the book and is measured once, and the token estimate is recomputed cheaply whenever a different model answers the endpoint (see `utils/tokens.js`, gotcha 54).

**A chapter is what the BOOK says is a chapter, not what the spine says** (`groupSpineIntoChapters` + `classifySectionGroup`). A reflowable Japanese light novel (the Kadokawa / BOOK☆WALKER "文章型" spec) gives **every page its own spine item**: the cover, the half-title illustrations, a full-colour insert in front of each chapter, the chapter text, the legal notice, the contents page, the author profile, a reader survey, an advertisement, the colophon. Volume 1 of the live 17-volume series has **35 spine items and 10 chapters**; reading the spine literally produced 35 "chapters", translated the copyright notice, spent research-agent turns on blank illustration plates, and reported 25 phantom "empty in source" holes in a book that has none (gotcha 52). The rule:

- A page the book's **nav/contents list names** OPENS a section; every unnamed page after it joins the open section. That also re-joins a long chapter the packager split across two files (第四章 is `p-010` + `p-011`) into ONE chapter.
- A named page is packaging when the book says so: `epub:type` in `cover / toc / colophon / copyright / ...`, a title that names packaging (表紙 / 目次 / 奥付 / 本編 …), or a landmarks-only pointer (`inToc: false` — "this is where the main text starts", not a chapter).
- An unnamed page never joins *packaging* — it starts its own group, so a real story sitting between the contents page and the first chapter's title page cannot become the cover's fine print. Such a group is a chapter when the pages that did **not** declare themselves packaging (`<body class>`, their own `<title>`) hold ≥ `SOURCE_UNDECLARED_SECTION_MIN_CHARS` (default = `SOURCE_EMPTY_SEGMENT_CHARS`) characters of story text — Markdown image markup is not text.
- Skipped groups are recorded in `bundle.packaging` (title, reason, pages, chars) and printed; if the skipped text exceeds 10% of the chapters' text the extraction warns that a real chapter may have been cut.
- A kept-but-unnamed section is titled from the heading the page itself prints (【俺とあいつが出会うまで】 — a centred `<p>`, not an `<h1>`), or `Untitled section N` with `syntheticTitle: true` when it prints none. A file name is never used as a chapter title: it ends up in `chapters.json` and every report and reads like a chapter the book has.
- **Fail-open:** a book whose nav names none of its readable pages (no nav, an empty nav, a nav pointing only outside the text) is not a zero-chapter book — every page stands alone (the pre-grouping behavior) and the extraction says loudly that the chapter count is a guess.

Chunked mode shape (all four pipelines): generation stages run per chapter in reading order — each chapter sees the previous chapter's output (chained, so no client-side merge for the cumulative artifacts: glossary / voice reference / style guide simply carry forward into the next chapter's state). The wiki is the exception: per-chapter section files (`wiki-<id>.md`) are assembled into `wiki.md` + `shared-wiki.md` by a merge agent. QA runs per-chapter validator partials → a findings-merge agent writes the standard `*-validation.md` → the unchanged acceptance one-shot scores it → per-chapter feedback applies the chapter-tagged findings. **Never iterate `bundle.segments` by filename** — `chN.K` interludes do not sort into reading order; always iterate the `segments` array (gotcha 20).

### Processing mode: whole-installment vs chapter by chapter (`planProcessingMode`)

The old rule was one character constant (`SOURCE_CHUNK_THRESHOLD_CHARS`, 120000) applied to every stage, every language and every model. Measured against the live 17-volume series it decided **all 17 volumes** should be processed chapter by chapter — while every one of them fitted the model's window comfortably (128,744–176,201 characters = 75,757–109,628 tokens against a 262,144-token window). A character count is language-blind, and it says nothing about the two other things that compete for the same window: the reference material the stage injects and the answer the stage has to write.

The rule is now asked per volume, per stage, in tokens:

```
source + injected references + instructions  <=  safetyFraction × roleWindow  −  reply reserve
```

- `roleWindow` / `reply reserve` — the role's own `<PREFIX>_CONTEXT_WINDOW` / `<PREFIX>_MAX_TOKENS` when configured, else `AI_CONTEXT_WINDOW` and the derived output cap. The reply reserve is not padding: the server rejects a request when prompt + `max_tokens` exceed its context (gotcha 36), so the room the answer needs is part of the arithmetic.
- `safetyFraction` — `SOURCE_CHUNK_SAFETY_FRACTION`, default 0.75. A window that is exactly full is a window with no room for the tail of a long generation.
- **injected references** — the previous volume's cumulative artifact(s), read and measured per volume, because they GROW every volume: a volume that fits whole at volume 3 may not fit at volume 17. The decision is re-asked, never cached across volumes.
- The estimate itself is calibrated per model endpoint first (one cheap probe against the volume's own text, at the point where the hooks have already switched the right container in — measuring at intake would describe whatever container happened to be up, since `discover` has no pre-hook on this machine).

`decideProcessingMode` runs the whole thing and **prints the numbers** (`whole installment is 101,596 tokens against a 131,020-token allowance (78%)`), plus a warning when the whole volume alone exceeds half the window — the constraint the arithmetic cannot see, because in whole mode the author agent reads the entire book through one `readFile` call and that text then sits in its own session, which compacts lossily once it outgrows the server's window.

**The other half of the question — can the answer be GENERATED?** Fitting the request and being able to write the answer are different limits, and the window arithmetic only sees the first. `decideProcessingMode` also measures the answer: the previous volume's cumulative artifact (already on disk, already read) × `ARTIFACT_GROWTH_FACTOR` is the size this stage must emit in one call, and `answerRoom` compares it — with the estimate margin — against the output cap. It prints the number, and warns when the answer does not fit the cap. It deliberately does **not** switch the mode: a cumulative reference is still written whole at the final chapter, so chapter-by-chapter mode cannot repair an oversized answer — the fix is a bigger `AI_MAX_TOKENS` / `<PREFIX>_MAX_TOKENS`, and the warning says so.

**The same rule, one level down (`planChapterSplit`).** The translation stage always works per chapter, but a chapter's PART size used to be one character constant (`TRANSLATE_CHUNK_CHARS`, 24000) for every chapter, model and language. Measured against the real 17 volumes it split **55 of 133 chapters** — while the largest chapter (49,840 characters = 34,716 tokens) fits in one call with 161,840 tokens of the window left over for the references. Splitting is not free: every split is a seam where the continuity tail has to rebuild the join, where the duplicate-stripping backstop fires, and where a name can drift between parts. Now both limits are checked per chapter and the log names whichever bound:

```
ADMISSION:    part + references + findings + instructions + 52 + max_tokens  <=  safetyFraction × window
FEASIBILITY:  part × TRANSLATION_OUTPUT_RATIO × thinkingFactor               <=  max_tokens
```

The character limit is then derived from the binding token limit using **that chapter's own measured characters-per-token** (the same token allowance is worth ~2.8× more Latin characters than CJK ones). `TRANSLATION_OUTPUT_RATIO` defaults per pair — seeded from the fixture's real JA→EN run (744 source tokens → 799-token draft = 1.07×) — and `measureOutputRatio` replaces it with what this series' already-translated chapters actually produced (their sources and drafts are both on disk), clamped so one lucky volume cannot make the plan looser than the table by more than half. `thinkingOutputFactor` accounts for reasoning being billed as output: with `TRANSLATE_THINKING=high` the same 133 chapters go from 0 splits to 30, which is the protection a character constant could never give.

When the token rule is unavailable — a bundle cached before schema 6 has no script mix, or a stage has no known window — it falls back to the legacy character rule and the reason **names which half was missing**. `--chunked` and `SOURCE_CHUNK_THRESHOLD_CHARS=0` remain hard overrides.

**Fallback on failure:** if a whole-installment pass fails in the one way that chunking actually repairs — the server refusing the request as too large, or a turn hitting the output cap while writing a file — `runVolumeWithModeFallback` wipes that attempt's outputs (including its `*-rolling-state.json`) and runs the volume again chapter by chapter, ONCE. The trigger is the tagged `tooBigForOnePassError` class and nothing else (gotcha 55).

### Pipeline hooks (per-machine, git-style)

Optional, git-style hooks let each machine attach its own side-effects (git
sync, notifications, backups, …) before and after each step and around the
whole default run, **without changing the committed source or `package.json`**.
See `hooks/README.md` for the full contract and examples.

- **Runner** — `utils/hooks.js` is a dumb "exec an executable file" loop: it
  discovers the hook, checks it's executable, and runs it with `AI_CLIENT_*`
  env vars. It never interprets hook content or loads npm packages, so a hook
  can shell out to whatever the local machine already has (git, curl, mail,
  `node` with built-ins, …).
- **Location** — `<root>/hooks/` (gitignored; only `README.md` + `*.sample`
  are tracked). Override with `AI_CLIENT_HOOKS_DIR` (the git `core.hooksPath`
  analogue).
- **Hook files** (first existing name wins) — `pre-<task>` / `post-<task>`
  (or `.sh` / `.js`) for `discover`, `glossary`, `character-voice`,
  `style-guide`, `jump-in-wiki`, `consistency-audit`, `translate`,
  `verify-translate`, `retranslate`, `translate-qa`, `polish`, plus **sub-phase hooks**
  `pre-verify-audit` (the verify borderline tiebreak batch) and
  `pre-polish-audit` (the polish cross-model final-audit batch) — fired by the
  tasks around their audit sub-phases (each is a single endpoint switch,
  never interleaved with the main stage) — and `pre-pipeline` /
  `post-pipeline` around the whole default run. Any executable with a
  shebang works. `pre-/post-translate-qa` wrap the WHOLE QA loop (a logical
  wrapper — they must not switch models).
- **Hook names are role labels, never model names** — the code asks for
  `pre-verify-audit` / `pre-polish-audit` and nothing else; which container
  answers that role is entirely this machine's hook business.
- **Model switching for the translation stage** — the translation stage talks
  to several endpoints, but on local setups the containers share one port, so
  only one can serve at a time. The per-machine pre-hooks for the translation
  tasks are what start the right container (`model-switch.sh`,
  `hooks/README.md` Example 4 — idempotent, `/health`-polled), including the
  sub-phase hooks that switch in the **audit** container for the cross-model
  checks (`pre-verify-audit.sh` for the verify tiebreak, `pre-polish-audit.sh`
  for the polish final audit) before each audit batch. The task code
  contains no Docker logic; it only runs a `GET /v1/models` sanity check
  (`harness.assertModelServing`) before its first call. The `translate-qa`
  loop fires these batch hooks on every round (up to two switches per round;
  a repeat is a no-op when the right container already serves).
- **Entirely optional** — no file → the step runs exactly as before (the
  common case); present-but-not-executable → warn + skip. **`--dry-run` runs
  no hooks** (side-effect-free).
- **Timeout** — a hook is killed after `AI_CLIENT_HOOK_TIMEOUT_MS` (default
  30 min; 0 = no bound), so a hung hook (a stuck model-switch poll, a wedged
  git push) can never block an un-monitored run forever; the kill is reported
  as a hook failure.
- **Failure** — a before-hook non-zero exit **aborts the step**; an after-hook
  runs even when the task failed (so a cleanup / "task failed" notification can
  fire), and a failed after-hook only masks the task error when the task had
  already failed (the task error always propagates).
- **Wiring** — each task is wrapped with `withHooks(task, taskFn)` in
  `gulpfile.js` (the task modules are untouched); `translate-qa` wraps its
  two half-round tasks the same way inside the loop (the per-batch hooks
  fire on every round); the default run is wrapped as the `pipeline`
  pseudo-step.

