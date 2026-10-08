# Environment reference (`.env`)

Every variable, its default, and what it decides.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

## 9. Environment reference (`.env`)

**One variable per decision.** The catalogue was consolidated: `PASSING_SCORE`
(one threshold for every scored gate), `STAGE_CONCURRENCY` (one worker-count
knob for every stage), `JUDGE_TEMPERATURE` + `STAGE_THINKING_LEVEL` (the calls
that grade rather than write), `AI_CONTEXT_WINDOW` (the server's context, which
also sizes the default output cap) and `SERIES_ARTIFACTS_DIR` (where the four
series-level copies go). The older per-gate names (`ACCEPTANCE_PASSING_SCORE`,
`VERIFY_PASSING_SCORE`, `POLISH_VERIFY_PASSING_SCORE`, `VERIFY_TEMPERATURE`,
`AUDIT_TEMPERATURE`, `EDIT_TEMPERATURE`, `<STAGE>_THINKING[_LEVEL]`,
`<STAGE>_CONCURRENCY`, `RESEARCH_CONCURRENCY`, `AGENT_CONTEXT_WINDOW`,
`*_OUTPUT_FILE`, `DISCOVERY_MAX_ATTEMPTS`) are still read as fallbacks, so an
existing `.env` keeps working unchanged — they are simply no longer the
documented knobs. `POLISH_VERIFY_TEMPERATURE` was removed outright: it was read
into a variable nothing ever used.

### AI provider (`AI_*`)

| Var | Default | Meaning |
|---|---|---|
| `AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `AI_API_KEY` | — (required) | Auth |
| `AI_MODEL` | `gpt-4o-mini` | Model id |
| `AI_CONTEXT_WINDOW` | `128000` | The model server's context window (tokens). One number for one fact: it sizes the default output cap AND the working window an uncapped delivery-layer turn is measured against (`utils/context.js`), so the two cannot contradict each other. It no longer drives silent session compaction — that is switched off on every agent handle (gotcha 56, gotcha 78). Legacy name `AGENT_CONTEXT_WINDOW` still honored |
| `AI_MAX_TOKENS` | a quarter of `AI_CONTEXT_WINDOW` | Max OUTPUT tokens per call. Derived so it can never equal the context (several servers reject that before the call starts — gotcha 36); set it only to override. **The live `.env` sets it to the model's published output ceiling (131072) rather than the derived quarter (65536)** — see gotcha 36 for what that trades away |
| `AI_TEMPERATURE` | `0.7` | Sampling temperature — the house temperature (it also applies to the polish pass) |
| `AI_RETRY` | `0` | Retries per AI call (API errors + empty responses) |
| `AI_CALL_DEADLINE_MS` | `3600000` | Idle deadline per model call (ms): aborts a call that makes no progress (no streamed events) for this long — the ONLY wall-clock bound (all fetch timeouts are disabled). An IDLE timeout reset on every event, so healthy long calls are never aborted; `0` = off. |
| `AI_THINKING` | on | Qwen3 thinking phase — **enabled by default**, for agent turns and stage calls alike. See docs/environment.md. |
| `AI_THINKING_LEVEL` | xhigh | reasoning_effort for the **authoring agents**: "low" / "medium" / "xhigh" (model-dependent). The judging/proofreading stages use `STAGE_THINKING_LEVEL` (calmer by default). |

### Series (`SERIES_*`)

| Var | Default | Meaning |
|---|---|---|
| `SERIES_LOCATION` | `<repo>/epub_source` | Folder holding the series — the intake agent explores it (volume folders, loose `.epub`/text files, art books, …), and every artifact is written next to the books. **Unset, it is the repo's own `epub_source/` folder**, which ships empty with a README saying what to drop in: a clone can run without ever naming a path. The run says out loud when it used the default; set the variable and it is used exactly as written (a relative value stays relative). An empty source folder is not a silent zero-volume run — intake fails and names the folder it looked in. → gotcha 79 |
| `SERIES_NAME` | — (optional) | Series name. Unset, the intake agent decides it from what the books say; set it and it **overrides** that decision (the agent is told to use it verbatim) |

`SERIES_LOCATION` is the only setting with a default, and the default is applied at the top
of every entry point (`configs/env-defaults.js`) rather than where the value is read —
several task modules turn it into a constant when they are required, and a default applied
later would be invisible to them (gotcha 79). In a container it is a path INSIDE the
container; `epub_source` works there because `docker-compose.yml` mounts the repo's own
folder at exactly that place (docs/docker.md).

### Series intake (`DISCOVER_*`)

Knobs for the `discover` step (docs/architecture.md.5). All optional — the defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `DISCOVER_SAMPLE_CHARS` | `1500` (max 6000) | How many characters of a book's text the intake agent may read per sample call. Raise it for a series whose books look alike |
| `DISCOVER_MIN_CONFIDENCE` | `0.6` | Lowest agent-reported confidence that lets the pipeline start; fail-closed (a plan reporting no `discovery.confidence` at all is rejected); `0` disables the gate |
| `DISCOVER_MIN_VOLUME_TEXT_CHARS` | `1000` | The "is there a readable text at all" floor for a staged volume (the objective half of the integrity check). Not a story-length rule — narrative-ness is the agent's call (each volume's `integrity` block). Catches binary junk / empty archives / stubs |
| `DISCOVER_ARTBOOK_MAX_TEXT_CHARS` | `20000` | The prose ceiling under which an image-dominated archive may be called an art book. Above it the book has a book's worth of text and the archive's composition is not allowed to override the agent (a real illustrated novel is mostly image bytes — see gotcha 51) |
| `DISCOVER_STRICT` | `false` | `true` turns a disagreement with the existing folder layout into an error instead of a warn-and-keep |
| `DISCOVER_MAX_ATTEMPTS` | `2` | Intake attempts before the step fails (fresh agent each attempt, 10 s apart). Legacy `DISCOVERY_MAX_ATTEMPTS` is still read as a fallback |

### Translation (`TRANSLATION_*`)

| Var | Default | Meaning |
|---|---|---|
| `TRANSLATION_SOURCE_LANGUAGE` | Japanese | **Override** for the source language — fills `{{SOURCE_LANGUAGE}}` in the prompts. Unset, the intake agent's `sourceLanguage` decides it |
| `TRANSLATION_TARGET_LANGUAGE` | English | Target language — fills `{{TARGET_LANGUAGE}}` in the prompts |
| `TRANSLATION_LENGTH_RATIO` | per-pair | The deterministic-QA length-ratio band (`"min-max"` or `"min-max-truncation"`). Unset, the per-pair default is used (JA→EN 0.6–2.5, ZH→EN 0.7–3.2, KO→EN 0.5–2.6). The source-script residue check is automatic per pair (JA→EN kana+Han, JA→ZH kana, KO→EN Hangul, ZH→EN Han) — no setting needed |

### Translation stage (`TRANSLATE_*`, `VERIFY_*`, `EDIT_*`)

Multi-model chain of the translation stage (docs/pipelines.md §8.5). Every role prefix
resolves `BASE_URL` / `API_KEY` / `MODEL` with fallback to the global `AI_*`
settings, so a single-model setup needs none of these. On local multi-model
setups the per-machine pre-hooks switch the model container per stage
(`hooks/README.md` Example 4) — the tasks only run the `/v1/models` check.

| Var | Default | Meaning |
|---|---|---|
| `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL` | `AI_*` | Endpoint for `translate` + `retranslate` (Hy-MT2) |
| `TRANSLATE_TEMPERATURE` | `0.7` | Hy-MT2 official sampling temperature (top_p 1.0 / top_k -1 / rep-pen 1.0 are fixed by the official recipe) |
| `TRANSLATE_THINKING` | `no_think` | Hy-MT2 thinking dialect: `no_think` / `low` / `high` (also accepts `true` → `low`, `false` → `no_think`) — mapped to `reasoning_effort` |
| `TRANSLATE_CHUNK_CHARS` | unset | **A ceiling only when you set it.** Unset, the part size is planned in tokens per chapter (`planChapterSplit` — see docs/pipelines.md §8.5). Set, it is respected as a hard maximum (minimum 2000) and it is also what stands when the role has no known window or output cap |
| `TRANSLATION_OUTPUT_RATIO` | per-pair | Expected OUTPUT tokens per token of source (`"1.2"`, or `"ja->en=1.1,ko->en=1.4"`). Unset, the per-pair table is used (JA→EN 1.10 — measured from the fixture's real run, 744 source tokens → 799-token draft — ZH→EN 1.15, KO→EN 1.20, CJK→CJK 1.0, anything else 1.25). This is NOT `TRANSLATION_LENGTH_RATIO`: that one is a CHARACTER band, this one is a TOKEN band, and the two disagree because the scripts cost different amounts per character |
| `TRANSLATE_CONTINUITY_CHARS` | `400` | Chars of the previous chapter-part's ending fed to the next part as continuity context (`0` = off) |
| `TRANSLATE_QA_MAX_ROUNDS` | `3` | Max `translate-qa` rounds (round = verify batch + retranslate batch); the loop stops earlier when all chapters pass or a round retranslates nothing (stalled) |
| `TRANSLATE_QA_RETRY_BUDGET` | `2` | How many times a chapter may be retranslated against an IDENTICAL set of verification findings before the loop calls it stalled (the stall guard's escape hatch: the translator runs at temp 0.7, so a second shot at the same findings can succeed; a different findings set resets the budget) |
| `VERIFY_TRANSLATE_ENABLED` | `true` | `false` disables `verify-translate` **and** `retranslate` **and** the `translate-qa` loop (one QA chain) — the pipeline degrades to translate → polish |
| `VERIFY_BASE_URL` / `VERIFY_API_KEY` / `VERIFY_MODEL` | `AI_*` | Endpoint for `verify-translate` |
| `EDIT_BASE_URL` / `EDIT_API_KEY` / `EDIT_MODEL` | `AI_*` | Endpoint for `polish` (its temperature is `AI_TEMPERATURE`, its thinking follows `AI_THINKING` + `STAGE_THINKING_LEVEL`) |
| `POLISH_VERIFY_ENABLED` | `true` | `false` gates the polish pass on the deterministic regression guard only (no AI drift audit) |
| `POLISH_QA_MAX_ROUNDS` | `3` | Max polish rounds per chapter (a round = Phase A guard-gated candidate + Phase B cross-model audit; a FAIL re-polishes on the `EDIT_*` endpoint and is re-audited next round) |
| `VERIFY_TIEBREAK_ENABLED` | `true` | `false` skips the verify borderline tiebreak (always trust the verifier's single score) |
| `VERIFY_TIEBREAK_BAND` | `5` | Chapters whose verify score lands within ±N of the passing score are re-scored on the `AUDIT_*` endpoint (cross-model) and the two scores averaged. An average may NOT pass a chapter when **both** graders scored below the line (that would be score laundering); a FAIL→PASS flip is allowed and recorded as `tiebreakRescue` |
| `VERIFY_SAMPLES` | `2` | How many times a borderline chapter is graded (max 5). The MEDIAN of the samples is the chapter's score — one grader's bad hour is not a FAIL |
| `VERIFY_SAMPLE_BAND` | `8` | Chapters whose score lands within ±N of the passing score get the repeat sampling above (chapters far from the line are graded once: the repeat exists to protect the coin-flip cases, not to double the bill) |
| `TRANSLATE_RETRANSLATE_VALUE_MARGIN` | `5` | A chapter that missed the passing score by less than N on MEDIUM/LOW findings only is NOT retranslated (a copy-edit is not worth a whole chapter of fresh generation, which can introduce new errors). A HIGH finding, a deterministic-QA failure, or an unparseable score is always worth it; skipped chapters are counted and reported |
| `TRANSLATION_EMPTY_SOURCE_CHARS` | `40` | Below this many characters of source, `translate` skips the chapter WITHOUT a model call and records it as "empty in source". Deliberately far below `SOURCE_EMPTY_SEGMENT_CHARS` so a genuinely short interlude is still translated |
| `TRANSLATE_TARGETED_FIX` | `true` | `false` always rewrites a whole chapter when it is retranslated. Default-ON: re-translate only the passages the findings quote and stitch them back (see docs/pipelines.md §8.5). Every case where the source↔draft mapping cannot be trusted falls back to the whole-chapter pass automatically, so this knob only turns the shortcut off |
| `VOLUME_CONSISTENCY_ENABLED` | `true` | `false` skips the cross-chapter audit (the deterministic rendering-variant scan still runs). Default-ON: it is the only pass that reads a volume's chapters together, and it rides in the existing `AUDIT_*` batch, so it costs no extra container switch |
| `<PREFIX>_CONTEXT_WINDOW` / `<PREFIX>_MAX_TOKENS` | `AI_*` | Per-role request size (`TRANSLATE_`, `VERIFY_`, `EDIT_`, `AUDIT_`): the translation stage's roles are not one model, so each gets its own context window and output cap. Every stage-start log names the endpoint, model, window, and where each came from |
| `AUDIT_BASE_URL` / `AUDIT_API_KEY` / `AUDIT_MODEL` | `AI_*` | Endpoint for the cross-model audits (verify tiebreak + polish final audit) — configure it to a DIFFERENT model than the stage being graded, or the audit is the same model grading its own work; on local setups the `verify-audit` / `polish-audit` hooks switch its container in (the model alias is usually `local`) |

### Thresholds, judging and concurrency

The knobs that used to be repeated per stage, now one each. Every scored gate
uses the same 0–100 rubric, so it has one threshold; every stage runs on the
same machine, so it has one worker count.

| Var | Default | Meaning |
|---|---|---|
| `PASSING_SCORE` | `70` | The one passing threshold (0–100) for **all three** scored gates: artifact acceptance (docs/pipelines.md), chapter verification (docs/pipelines.md §8.5) and the polish drift audit. 70 is the rubric boundary between "Pass with minor edits" (70–84) and "Requires revision" (40–69). Legacy names `ACCEPTANCE_PASSING_SCORE` / `VERIFY_PASSING_SCORE` / `POLISH_VERIFY_PASSING_SCORE` still override it, in that order |
| `JUDGE_TEMPERATURE` | `0.2` | Sampling temperature for every call that grades text (the four acceptance graders, verification, the verify tiebreak, the cross-chapter audit, the polish drift audit). Legacy `VERIFY_TEMPERATURE` / `AUDIT_TEMPERATURE` still override |
| `STAGE_THINKING_LEVEL` | `medium` | How hard every call that GRADES deliberates (verify / audit / polish / the four acceptance graders) — deliberately calmer than the authoring agents' `AI_THINKING_LEVEL`, because reasoning tokens are billed out of the same reply budget as the score (gotcha 59). `AI_THINKING=false` turns their thinking off too. Legacy `<STAGE>_THINKING[_LEVEL]` still override |
| `ACCEPTANCE_THINKING` / `ACCEPTANCE_THINKING_LEVEL` | `AI_THINKING` / `STAGE_THINKING_LEVEL` | Override for the four pre-production acceptance grades alone (the calls that decide whether a glossary / voice reference / style guide / wiki is accepted). Same reader as the stage overrides — `judgeThinking()` in configs/shared.js |
| `STAGE_CONCURRENCY` | `1` | Independent units a stage runs at once: chapters per verify / retranslate / polish pass, chapters per audit batch, research agents per glossary term. `translate` stays serial by design (its chapters are chained by the continuity tail). Legacy per-stage names `RESEARCH_CONCURRENCY` / `VERIFY_CONCURRENCY` / `RETRANSLATE_CONCURRENCY` / `POLISH_CONCURRENCY` / `AUDIT_CONCURRENCY` still override per stage |

### Source bundle (`SOURCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `SOURCE_CHUNK_SAFETY_FRACTION` | `0.75` | How much of the model's context window ONE pass may consider itself entitled to; the rest is left for the answer it has to write and for the estimate being a little wrong (see docs/architecture.md "Processing mode"). One knob for BOTH size decisions — the whole-installment one and the chapter-part one (`chunkSafetyFraction` now lives in `utils/tokens.js`, and `utils/source.js` re-exports it). Lower it if whole-mode passes keep hitting the output cap; raise it if volumes are chunked when you know they fit. |
| `SOURCE_CHUNK_THRESHOLD_CHARS` | `120000` | **Legacy**, now the FALLBACK rule: used when the token rule is unavailable (a bundle cached before schema 6, or a stage with no known context window). Set it to `0` to always take the chapter-by-chapter path for multi-chapter volumes, whatever the token check says. `--chunked` forces it for any multi-chapter epub. |
| `SOURCE_EMPTY_SEGMENT_CHARS` | `200` | The extraction's "this section converted to nothing" floor: a spine item whose extracted text is shorter is flagged `empty` (a blank page, an image-only page, text in a structure the converter does not map) and reported at extraction. Distinct from `TRANSLATION_EMPTY_SOURCE_CHARS` (below), which is the translation stage's "don't spend a model call" floor |
| `SOURCE_UNDECLARED_SECTION_MIN_CHARS` | `SOURCE_EMPTY_SEGMENT_CHARS` | The floor of story text an unnamed page group must hold to be kept as a chapter (see docs/architecture.md "A chapter is what the BOOK says is a chapter"). Only pages that did not declare themselves packaging count towards it. Lower it for a series with genuinely tiny interludes; raise it if a series' packaging pages hold long boilerplate |

### Token accounting (`TOKEN_*`)

The pipeline has no tokenizer — the model server owns one — so every size decision it makes rests on an estimate (`utils/tokens.js`). The coefficients are fitted against the live server's own counts, and each model endpoint is re-measured with one cheap probe. All optional; the defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `TOKEN_ESTIMATE_MARGIN` | `1.15` | Extra safety on top of the estimate. The estimate must stay an OVER-estimate: over-estimating trims a little more than needed, under-estimating is how a request gets rejected mid-run. Sized from the measurement (a calibrated base estimate lands up to ~5% UNDER one volume's own count, because the script mix varies volume to volume), and it replaces the accidental 1.45× the old coefficients carried, which wasted ~45% of every prompt budget. Must be ≥ 1. |
| `TOKEN_CALIBRATION_ENABLED` | `true` | `false` skips the probe and uses the built-in coefficients for every model. |
| `TOKEN_CALIBRATION_MAX_AGE_HOURS` | `24` | How long a stored calibration stays trusted. On a shared-port setup every container advertises the same alias (gotcha 22), so the age is what eventually re-measures a model swapped in behind the same URL. `0` = calibrate once per machine. |
| `TOKEN_CALIBRATION_SAMPLE_CHARS` | `8000` | How many characters of the volume's own text a calibration probe sends (it costs the server its prefill and generates one token — ~2–3 s at this size). |
| `TOKEN_CALIBRATION_FILE` | `<repo>/.token-calibration.json` | Where the per-model measurements are cached (gitignored machine state, like `hooks/.model-switch-state`). |
| `ARTIFACT_GROWTH_FACTOR` | `1.25` | How much a cumulative reference is expected to grow from one volume to the next. `decideProcessingMode` measures the previous volume's artifact and multiplies by this to get the size of the answer the stage must write, then reports it against the output cap (see docs/architecture.md "Processing mode"). Below 1 is rejected — a cumulative reference does not shrink. |

### Agents (`AGENT_*`)

| Var | Default | Meaning |
|---|---|---|
| `AGENT_MAX_STEPS` | `20` | Default step cap for tool agents (workflows pass higher caps where needed). It applies to pipeline-stage agents only — the diagnostics and dev-team turns have no step cap and use `AGENT_CONTEXT_CHUNK_STEPS` instead (see "The uncapped turn") |
| `AGENT_TEXT_GUARD_CHARS` | `30000` | Runaway-generation guard: abort an agent turn when it produces more than this many chars of text with fewer than 3 tool calls. Catches models that emit malformed tool-call text instead of using the tool-calling API. |
| `AGENT_RECOVERY_ENABLED` | `true` | Recovery turn when an author agent replies in chat instead of `writeFile` — asks it to write the file with the content it already generated |
| `AGENT_RECOVERY_MIN_CHARS` | `1000` | The smallest a chat reply may be before it is allowed to stand as an artifact when the agent replied in chat instead of writing the file. The reply must also look like the document the prompt asked for (a Markdown heading or a table). `0` turns the plausibility gate off and writes whatever the model said (gotcha 58) |
| `AGENT_MAX_LINE_LENGTH` | `8000` | Longest line an agent's `readFile`/`grep` may see in one call. The library default (2000) cuts a cumulative artifact's long entries in half, so the agent cannot read what it must preserve |
| `AGENT_MAX_READ_BYTES` | `65536` | Largest `readFile`/`listFiles`/`grep` answer in bytes. The library default (32 KB) forces a big artifact to be read in pages — and every page re-bills the whole transcript so far |

### Cumulative-document guards (`GLOSSARY_*`, `VOICE_*`, `STYLE_*`)

These knobs exist because the cumulative documents stop fitting in one reply (gotcha 64), and because the gates that catch the damage must not mistake an improvement for a loss (gotcha 65). All optional; the defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `GLOSSARY_CARRY_FORWARD_GUARD` | `true` | The no-AI gate that fails a volume whose glossary lost a term the previous volume's held (and moves the damaged file to `glossary.md.rejected`). `false` turns the cumulative invariant back into something nothing checks — which is how 457 terms disappeared between two volumes on the live run without a single error |
| `GLOSSARY_INDEX_MAX_CHARS` | `30000` | How big the inlined "what the glossary already holds" map may get before it truncates. It names the truncation and says what absence from the list does NOT prove (gotcha 43). Two consumers now: the amend agent's map of the file it is about to edit, and the complete term list the truncated extraction window appends so a cut row is still a named term (gotcha 82). `0` = no cap |
| `VOICE_CARRY_FORWARD_GUARD` | `true` | The same gate for the character voice reference, on the `### Character` section set (damaged file moved to `character-voice.md.rejected`) |
| `VOICE_INDEX_MAX_CHARS` | `12000` | The cap on the inlined "who is already in the reference" section map |
| `STYLE_CARRY_FORWARD_GUARD` | `true` | The same gate for the style guide, on the `## ` category set only (a drop in the rule count is reported, not failed). Damaged file moved to `style-guide.md.rejected` |

### QA loop & acceptance (`QA_*`, `ACCEPTANCE_*`)

| Var | Default | Meaning |
|---|---|---|
| `QA_MAX_ITERATIONS` | `10` | QA-loop cap per volume (increased to allow rolling average to converge) |
| `ACCEPTANCE_WINDOW_SIZE` | `2` | Number of recent acceptance checks in the rolling window. How many checks it needs before it can fire is derived from it (`min(2, window)`) — not a separate knob, because a window can never hold more samples than its own size |
| `ACCEPTANCE_SAMPLE_FLOOR` | `PASSING_SCORE − 15` | The lowest a SINGLE score in the window may be. Without it an average launders a rejection: with a window of 2 and a passing score of 69, `[100, 38]` accepted an artifact one grader called *atrocious*. `0` restores pure averaging |
| `ACCEPTANCE_EXCEPTIONAL_SCORE` | `85` | A grade at or above this (the rubric's top band) triggers the fast-accept path: `ACCEPTANCE_CONFIRMATION_CHECKS` extra grades, one of them at temperature 0. When every grade stays within `ACCEPTANCE_SCORE_TOLERANCE` of the exceptional score and the deterministic grade agrees, the artifact is accepted immediately — no feedback round (an artifact a grader called perfect does not need a stochastic rewrite to "confirm" it) |
| `ACCEPTANCE_SCORE_TOLERANCE` | `3` | How far a confirmation grade may fall before the exceptional grade is judged a fluke and the normal loop continues |
| `ACCEPTANCE_CONFIRMATION_CHECKS` | `2` | How many extra grades the exceptional-consensus path runs |
| `ACCEPTANCE_CONFIRM_ON_PASSING` | `true` | Let a grade that ALREADY passes earn the window's remaining samples by re-grading the same artifact, instead of buying them with a feedback rewrite plus a full re-audit (see docs/architecture.md "QA loop" and gotcha 65). `false` restores the old route exactly |

### Un-monitored run policies (`ON_*`, `DISCOVER_*`)

Front-loaded decisions so a long run never halts waiting for a human (code
defaults are the safe "fail loudly" behavior; the committed `.env` sets the
un-monitored values). Skipped work is picked up on a cheap idempotent re-run.

| Var | Default | Meaning |
|---|---|---|
| `ON_VOLUME_ERROR` | `abort` | When a volume's processing fails: `abort` stops the task; `skip` logs the error and continues with the next volume |
| `ON_MISSING_PREVIOUS` | `abort` | When a cumulative task finds the previous volume's artifact missing: `abort` fails loudly; `skip` warns and skips the volume (later volumes cascade the same way) |
| `ON_QA_LIMIT` | `accept` | When the QA loop hits `QA_MAX_ITERATIONS` without a passing grade: `accept` keeps the output as-is; `fail` treats the volume as failed (then subject to `ON_VOLUME_ERROR`) |
| `ON_TASK_ERROR` | `abort` | Default run: `abort` stops at the first failing step; `continue` runs the remaining steps, then fails the run with a summary |
| `DISCOVER_MAX_ATTEMPTS` | `2` | Intake-agent attempts before failing the step (fresh agent each attempt, 10 s apart; per-attempt endpoint retries still apply via `AI_RETRY`). See docs/architecture.md.5 |

### Output locations

| Var | Default | Meaning |
|---|---|---|
| `SERIES_ARTIFACTS_DIR` | `<SERIES_LOCATION>` | Where the four series-level copies are published: `glossary.md`, `character-voice.md`, `style-guide.md`, `shared-wiki.md` (the newest per-volume `shared-wiki.md` is copied here after the jump-in-wiki task — the series-level living wiki). Legacy per-file names `GLOSSARY_OUTPUT_FILE` / `VOICE_OUTPUT_FILE` / `STYLE_OUTPUT_FILE` / `SHARED_WIKI_OUTPUT_FILE` still override individually |

**Provenance sidecars:** every root copy (glossary / character-voice /
style-guide / shared-wiki) also gets a `<file>.provenance.json` next to it
(source volume, copy timestamp, content hash — `writeProvenanceSidecar` in
`utils/fs.js`), so it is always visible WHICH volume snapshot a root artifact
was copied from.

### Step-by-step runner and post-mortem (`index.js` — `POSTMORTEM_*`, `INDEX_*`)

Only used by `npm run pipeline` (`node index.js`). `npx gulp` is unaffected.

| Var | Default | Meaning |
|---|---|---|
| `POSTMORTEM_ENABLED` | `true` | `false` runs the steps without assessing any of them (orchestration only). `--post-mortem=off` is the same switch on the command line |
| `POSTMORTEM_FAIL_ON` | `high` | Which finding levels make `index.js` exit non-zero: `high` (the step did not finish what it claims to have), `medium` (also gaps), `never` (report everything, exit 0). **Start at `never`** while the check is new, and read which findings are real before letting any of them fail a run |
| `POSTMORTEM_DIR` | `<repo>/.postmortem` | Where `<step>.md` / `<step>.json` reports, the ledger, the tickets, the delivery plan, the structural-failure marker and the run lock are written. Gitignored machine state, like `.logs/`. It is also what makes a run lock mean something: the lock is per `POSTMORTEM_DIR`, not per series, so running two series at once needs a separate one each |
| `INDEX_STEP_TIMEOUT_MS` | `0` (no bound) | Wall-clock ceiling for one step. The default is deliberately unbounded: a 17-volume run legitimately takes days, and a single model call is already bounded by `AI_CALL_DEADLINE_MS` (an IDLE timeout — gotcha 26). A step-level clock would false-positive on a healthy long stage |

### Run ledger and tickets (`utils/ledger.js`, `utils/tickets.js` — `LEDGER_*`, `TICKETS_*`, `INDEX_RUN_ID`)

What a run has already tried, whether it helped, and what it asked the teams that can see the
code. Written to `<POSTMORTEM_DIR>/ledger.json` and `<POSTMORTEM_DIR>/tickets.json` + `.md`
(gitignored machine state). All optional; the defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `LEDGER_ENABLED` | `true` | `false` records nothing (`--ledger=off` is the same switch on the command line). Turning it off turns the anti-spin gate off with it |
| `LEDGER_SPIN_ATTEMPTS` | `2` | How many prior attempts of the SAME action against the SAME finding, ending `unchanged` or `worse`, make the next one refused. Two because one failure can be an accident (a container that was not up); the same action failing twice against the same finding is the shape of a deterministic gate rejecting the same file. Minimum 1 |
| `LEDGER_MAX_ENTRIES` | `5000` | How many entries the ledger keeps; above it the OLDEST are dropped and the cumulative number dropped is recorded in the file, so a reader can tell the history is incomplete. Minimum 100 |
| `INDEX_RUN_ID` | a per-process timestamp | Groups a run's entries. The anti-spin count is per run, so a wrapper or test can name the run it wants counted together — and a real fix is not frozen out of the next run. `index.js` sets it once for the whole sequence and every step child inherits it. Act mode deliberately does NOT invent its own: it records under the **newest recorded run**, because a manager that starts a fresh id per invocation can never be caught repeating itself — the count only resets when a genuinely new `npm run pipeline` run makes its own id |
| `TICKETS_ENABLED` | `true` | `false` opens no tickets. There is no knob for the banned-option filter and there will not be one: it is the constraint on the option generator, and a filter the manager can switch off is not a constraint (gotcha 70) |

### The uncapped turn (`utils/context.js` — `AGENT_*`, `CONTEXT_*`, `RECALL_*`)

The knobs of the delivery layer's working memory (docs/delivery-layer.md "Uncapped turns", gotcha 78). They apply to the diagnostics
turn and the dev turn ONLY — a pipeline stage agent has no context-management tools, no pressure line, and no chunked
turn, whatever is set here. Every one is read per call, so a test may pin one for a single scenario. All optional; the
defaults are the tuned values.

| Var | Default | Meaning |
|---|---|---|
| `AGENT_CONTEXT_CHUNK_STEPS` | `12` (min 1) | How many model steps one CHUNK of an uncapped turn gets before the harness is allowed to set old reads aside and continue. It is NOT a turn limit — there is no limit on chunks. Lower it if a turn keeps hitting the output cap inside one chunk; raise it if offloads fire too eagerly |
| `CONTEXT_SOFT_LIMIT` | `0.70` | The fraction of `AI_CONTEXT_WINDOW` at which the pressure line starts telling the agent to offload on its own. Must be between 0 and 1 |
| `CONTEXT_HARD_LIMIT` | `0.90` | The fraction at which the harness offloads by itself, without being asked. Never lower than the soft limit |
| `CONTEXT_KEEP_RECENT_TOKENS` | `40000` (floor 1000) | How much of the END of the conversation is never moved — the agent's most recent reading stays in front of it. An offload walks backwards from the newest message and stops here |
| `RECALL_MAX_BYTES` | `16384` (floor 512) | How much text `recall_memory` may hand back, in BYTES. An agent asking for less is raised to the floor, because a 10-byte answer is indistinguishable from "nothing matched" (gotcha 60's silent-nothing failure) |
| `AGENT_REPEAT_LIMIT` | `3` (min 2) | How many IDENTICAL tool calls (same tool, same arguments, same answer) one turn may make before it is stopped. This is the wall that replaced the step cap. Note the consequence: three identical refused writes in one turn abort that turn mid-work |
| `AGENT_COMPACT_EXHAUSTION` | `3` (min 2) | How many consecutive offloads that trim with no new tool calls the harness tolerates before it stops the turn and says honestly that the job does not fit in one turn |
| `AGENT_TURN_MAX_MS` | `7200000` (2 h) | The loose ceiling on one uncapped turn. A wall, not a budget — the same shape as `AUTOPILOT_MAX_ITERATIONS`. `0` removes it, which is a deliberate removal of the last wall, not an oversight |

There is no knob for `CONTEXT_MANAGED_ROLES` (which roles get the managed turn) and there will not be one, for the
standing reason in this file: a constraint the role can switch off is not a constraint (gotcha 70). Turning context
management on for a pipeline stage is not a tuning decision — it is the stage agent putting its own reading out of
context, which is gotcha 64.

### The diagnostics team (`diagnose.js`, `utils/diagnostics.js`)

One model call per ticket, and no new knobs of its own. The reply contract, the shape rules and the read-only tool set
are code constants for the same reason the action menu and the signal table are: they are the constraints on the role,
and a constraint the role can switch off is not a constraint. **It has no step cap** — the turn is uncapped and
self-offloading, so the knobs that bound it are the shared ones in the table above (`AGENT_REPEAT_LIMIT`,
`AGENT_TURN_MAX_MS`, `CONTEXT_KEEP_RECENT_TOKENS`). `TICKETS_ENABLED=false` stops the channel, which stops this side of
it too. The diagnosis turn's reply budget is the harness's normal output cap (`AI_MAX_TOKENS`, see gotcha 36) — it
passes no per-call cap of its own, and `DELIVERY_MAX_TOKENS` is not read by any code yet.

### The dev team (`fix.js`, `utils/devteam.js`, `utils/patches.js`)

No new variables, for the same reason the diagnostics team has none. The banned-path table, the pinned checks
(`npm test` then `npm run pipeline-loop`), the proposal contract and the 30-minute ceiling on one check are all code
constants: they are the constraints on the role, and a constraint the role can switch off is not a constraint (gotcha
70). **The turn has no step cap** (it reads code before it writes it, which is what a cap punished), so what bounds it
is the shared table above. The turn's reply budget is again the harness's normal output cap.
`TICKETS_ENABLED=false` stops the channel, which stops this side of it too. What the account owner does have is the two
verbs: `npm run delivery -- --accept-patch=<id> --reason="…"` or `--reject-patch=<id> --reason="…"`, and then
`npm run fix -- --commit=<id>` or `--revert=<id>`.

### The delivery manager (`delivery.js`, `utils/resume.js` — `DELIVERY_*`)

The manager's own settings. `report` is still the default: the manager earns the authority to act by
writing a report that is demonstrably right about a real run, and `act` mode is now built so the switch
means something.

| Var | Default | Meaning |
|---|---|---|
| `DELIVERY_MODE` | `report` | `report` reads the state and writes a proposal, and executes nothing. `act` executes the plan one step at a time through the step runner, gated by the action menu, the per-step budget, the anti-spin ledger and the run lock (see docs/delivery-layer.md). Keep `report` until the written plan is demonstrably right about your own run — the report is what the account owner reads before letting the manager touch anything |
| `DELIVERY_MAX_INTERVENTIONS` | `5` | How many interventions the manager may make **on one step** before it must stop acting on that step and write a report / open a ticket instead. **Per step, not per run** (account owner, 2026-10-06): a run with nine steps is nine problems, and a global cap spends glossary's attempts on the wiki. Resume triage is not counted at all — `countsAsIntervention` on each `DELIVERY_ACTIONS` entry is what makes "picking up unfinished work is free, destroying finished work is an intervention" a field instead of a sentence. This is a separate limit from the anti-spin gate: the ledger refuses the same action against the same finding twice; this refuses to keep doing *anything* to one step. Enforced twice — `planResume` turns an over-budget step into `open-ticket` in the proposal, and act mode refuses the action at execution time and opens a ticket with the evidence it read |
| `DELIVERY_MAX_TOKENS` | `131072` | The output cap for the delivery manager's own decision call (`managerMaxTokens()` in `utils/manager.js`, floor 1024): one shaped report in, one JSON action out. The cap exists so a manager cannot spend a stage's reply budget writing prose. The diagnostics and dev-team turns have their own step caps (`utils/diagnostics.js`, `utils/devteam.js`), and **act mode itself still makes no model call**: it reads state, gates actions, spawns the step runner and compares the deliverable, all deterministically. **There is no token budget and there will not be one** (no `DELIVERY_TOKEN_BUDGET`): the ceiling on one decision is the model's own output cap, and what stops a spin is the ledger, not a spending limit — a spending limit would hide the spin behind a cost error, and the spin is the thing this layer exists to catch. Note the tension this machine actually has: the model behind the endpoint publishes 131,072 for a final response and 262,144 for reasoning *against a 1M context*, while this server serves the model's native 262,144 window — so the window binds (gotcha 36) and reasoning is billed as output (gotcha 59) |

There is no knob for the closed action menu and there will not be one, for the same reason there is
no knob for the banned-option filter (gotcha 70): a menu the manager can widen is not a menu. The
same applies to `utils/manager.js`: no knob for the decision vocabulary, the accept-safety test, or
the reply parser's fail-closed rules.

### The autopilot (`autopilot.js` — `AUTOPILOT_*`)

| Var | Default | Meaning |
|---|---|---|
| `AUTOPILOT_MODE` | `watch` | `watch` reads the state, asks the manager, and prints the decision, the whole menu it was offered and the exact command act mode would have run — and writes **nothing**: no ticket, no ledger entry, no plan file, no run lock. `act` drives the run by spawning the account owner's own commands. Watch is the default because it is the only safe rehearsal: act mode refuses `--no-write` with `--mode=act` because a recorded intervention that did nothing poisons the ledger that exists to catch a spin (gotcha 72). Switch to `act` after reading what the manager decided about a real run of your own series |
| `AUTOPILOT_MAX_ITERATIONS` | `12` | How many decisions the loop may make before it stops and reports. **A wall, not a budget**: the anti-spin gate needs a repetition and `DELIVERY_MAX_INTERVENTIONS` needs an intervention, and a loop making legal, different, non-repeating moves that never reach a provable end trips neither. That case should not run overnight |

Two things the loop will not do whatever is set here: **accept a patch unattended** unless
`safeToAcceptAutomatically` vouches for it (ordinary project code, the pinned checks green, no warning
on the proposal, nothing the team escalated in prose, no measured regression on the deliverable) —
anything else stops and names the account owner; and **make a Tier C move**, which it escalates
instead. There is no knob for either, and no `--dry-run`: that flag also suppresses hooks, and on a
machine where the hooks decide which container answers, that would make the manager's model switch
silently optional (gotcha 22). See docs/delivery-layer.md and gotcha 76.

### Research (`RESEARCH_*`, `WIKI_*`, `SEARCH_*`)

| Var | Default | Meaning |
|---|---|---|
| `RESEARCH_ENABLED` | `true` | Research new glossary terms |
| `RESEARCH_MAX_RESULTS` / `RESEARCH_EXTRACT_CHARS` | `3` / `800` | Research result size |
| `RESEARCH_DELAY_MS` / `RESEARCH_TIMEOUT_MS` | `300` / `30000` | Politeness delay / per-request timeout |
| `WIKI_LANGS` | `ja,en` | Wikipedia languages to query |
| `WIKI_USER_AGENT` | built-in | Descriptive UA (Wikipedia requires one) |
| `SEARCH_API` / `SEARCH_API_KEY` | off | Optional brave / tavily / serper backend |

**Current local setup** (the committed `.env`): local Qwen at `AI_BASE_URL=http://localhost:9200/v1` with `AI_MODEL=local`, `AI_CONTEXT_WINDOW=262144` (so the output cap derives to 65536), `AI_TEMPERATURE=0.6`, `AI_RETRY=2`, `QA_MAX_ITERATIONS=5`, `PASSING_SCORE=69`, `TRANSLATE_QA_MAX_ROUNDS=5`, `DISCOVER_MAX_ATTEMPTS=3`, the un-monitored policies (`ON_VOLUME_ERROR=skip`, `ON_MISSING_PREVIOUS=skip`, `ON_TASK_ERROR=continue`), thinking on at `xhigh` (default), series = `test-series` (the `test_story` fixture), target language English. It sets **nothing else**: no `SERIES_NAME` and no `TRANSLATION_SOURCE_LANGUAGE`, so the intake agent actually has to work out the series name and the source language, and no role endpoints, so every role resolves through the `AI_*` fallback. The per-machine hooks still map each role to a container — `hooks/pre-translate.sh` / `pre-retranslate.sh` → Hy-MT2, `hooks/pre-verify-translate.sh` / `pre-polish.sh` → **Qwen3.8-flash-next** (also pre-warmed by `post-translate.sh` / `post-retranslate.sh`), `hooks/pre-verify-audit.sh` / `pre-polish-audit.sh` → **Qwen3.8-27b-beellama** (the cross-checks), `hooks/post-polish.sh` → back to **Qwen3.8-flash-next** once the run ends (the default resting model). The `translate-qa` loop re-fires the batch hooks on every round boundary; the state file makes a repeat switch a no-op. This mapping is pure hook policy — nothing in the task code knows these model names. **It points at the test fixture, not the real 17 volumes** — check this before any "production" run. (The untracked `.env` on the machine running the real series differs: it points `SERIES_LOCATION` at the 17 volumes, sets `AI_THINKING_LEVEL=medium` because the live run measured 173M tokens and 22 empty replies from the authoring agents' default `xhigh` reasoning (gotcha 1, gotcha 58), and sets `AI_MAX_TOKENS=131072` — the served model's published output ceiling — instead of the derived 65,536, which halves the prompt allowance the whole-installment decision is made against (gotcha 36).)

