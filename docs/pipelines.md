# The pipelines, one at a time

Sections 4 to 8.5: glossary, jump-in-wiki, character-voice, style-guide, the consistency audit and
handoff, and the translation stage.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

## 4. Pipeline A: glossary (`glossary.js`)

Per volume, in order — each volume's glossary is built on the previous one's:

1. **Extract new terms** — one-shot in both modes: source + previous `glossary.md` → JSON array of `{ term, type, query }`; parsed by `parseTerms` (tolerates markdown fences and surrounding prose). When the previous glossary is over `GLOSSARY_TRUNCATION_THRESHOLD` the inlined copy goes through `truncateGlossary`: `GLOSSARY_TRUNCATION_MAX_ENTRIES` (200) full rows, chosen by whether the row's term occurs in the text being processed — matched under **any spelling the row names**, verbatim or by its Han-character skeleton, which is the only form in which two furiganed spellings of one term compare equal — and then the **complete term → rendering list of the whole file** (`buildGlossaryIndex`) appended underneath, so the window hides a row's Notes and never the existence of an entry. The extractor has no file tools, so that list is the only way its "do not re-propose what already exists" instruction can be obeyed (gotcha 82).
2. **Research** the new terms:
   - **Parallel agents**: one agent per term, batched to `STAGE_CONCURRENCY` (env var, default 1 = sequential). Each agent targets exactly one unique line in `glossary-research.md` via `editFile`, so there are no conflicts.
   - Skeleton-first: the workflow pre-writes `glossary-research.md` with a `- (pending)` line under every term; each agent replaces its own placeholder. A crashed run still leaves a usable skeleton.
   - `maxSteps = 15` per agent (2 wiki_search + 1 wiki_extract + 1 editFile + overhead).
   - Set `STAGE_CONCURRENCY` above 1 to research terms in parallel (the default 1 is sequential).
3. **Amend** the glossary (carry forward every existing term, add the new ones, reconcile conflicts):
   - **The workflow copies the baseline in first** (`seedGlossaryFromPrevious`): the previous volume's `glossary.md` is copied verbatim into this volume's folder before any agent runs, and `buildGlossaryIndex` turns it into a compact per-section **term → rendering index** that is inlined into the turn prompt. The agent's job is therefore **`editFile` row insertion**, not reproduction: `glossaryWriteInstruction(seeded)` tells it so and explicitly forbids the whole-file `writeFile` (see gotcha 64). For the first volume — or a failed seed — the same helper produces the opposite instruction, because there the agent really does have to create the file. **Both halves are decided by reading the file, not by remembering how it got there** (`readArtifactToAmend` in `utils/fs/current-artifact.js`, called by the author pass of all three cumulative stages): the chapter-by-chapter path of volume 01 has nothing to copy in, and the document has been in the folder since chapter 1, so a flag set by the copy stays false while the file is there and growing (gotcha 89). `--dry-run` previews BOTH halves of that: the instruction and the index built from the file that is actually in the folder, so the dump is the prompt the live run would send and not a prompt that promises "amend in place" while hiding the map the agent uses to find the row.
   - an **author agent** (standalone — creates and closes its own session; step cap `authorMaxStepsFor(glossaryBytes, sourceBytes)`) reads the materials with `readFile`/`grep` and amends `glossary.md` with `editFile`.
   - **After every amend and feedback pass, a deterministic carry-forward gate** (`assertGlossaryCarryForward` → `compareGlossaryCarryForward`, no model call) checks that this volume's glossary still holds every term the previous volume's held. It compares entries at SPELLING resolution (`glossaryTermSpans`): a row's term column is often several source-language spellings of one entry written as `A / B / C`, and an entry counts as carried when every spelling it named is still present in some current row — as its own row, inside a longer (widened) one, or across several (a split row). The gate is about the terminology, not the formatting of the row that held it: an agent that widens a row with a new alias improved the glossary, and comparing whole cells as exact strings called that a loss and quarantined a volume 02 that had grown from 88 terms to 140 (gotcha 65). The third legitimate form is a **rename** — the row now names a different source-language spelling of the same thing, which is what the amend prompt tells the agent to do when this volume writes an old name a new way; it counts as carried when the row still documents the earlier spelling (anywhere in the row, the Notes column's "also written …") or the row carries the same target-language rendering and that rendering is unique on both sides, and it is reported as `renamed` and logged by name (gotcha 68). A real loss **fails the volume** and moves the damaged file to `glossary.md.rejected` (`quarantineDamagedGlossary`) so the next volume cannot read it — which is what makes the `ON_MISSING_PREVIOUS` cascade fire (see gotcha 64). The chunked flow runs the same gate **between chapters** (`guardCarryForwardAgainst`), because that is where the damage actually happened. Knob: `GLOSSARY_CARRY_FORWARD_GUARD=false`.
4. **QA loop**: a fresh validator agent per iteration (step cap **scaled to source size**: `max(40, 2·ceil(bytes/32KB) + 24)` — `validatorMaxStepsFor`) writes `glossary-validation.md` → acceptance one-shot → on FAIL a **fresh author agent** per iteration applies the feedback (no persistent session). Chunked mode: per-chapter validator partials → a findings-merge agent (step cap `findingsMergeMaxStepsFor(segmentCount, glossaryBytes)`) → acceptance → per-chapter feedback.
5. After all volumes: the **last** volume's `glossary.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/glossary.md`). Skipped for `--volume` runs (a single volume's snapshot would be stale).

The extraction step also persists `glossary-new-terms.json` (the new-terms snapshot for the translation handoff), and after the QA loop a **deterministic coverage audit** (no AI) parses the glossary table and writes `glossary-coverage.md` + `glossary-coverage.json` (machine-readable sidecar) — per-term occurrence counts in the volume source (substring matching, the correct semantics for Japanese) plus the zero-occurrence terms (hallucinated-entry candidates; the AI validator's completeness check is the complementary judgment-based half).

Artifacts per volume folder: `glossary.md` (snapshot), `glossary-new-terms.json` (extraction snapshot), `glossary-research.md`, `glossary-validation.md`, `glossary-coverage.md` + `glossary-coverage.json` (deterministic coverage audit), and `glossary.md.rejected` (a glossary the carry-forward gate rejected — kept as evidence, never read by the next volume).

**Cumulative invariant:** regenerating any volume sets `regeneratedAny` → **all later volumes are regenerated too** (their glossaries would otherwise build on a stale base). Do not "fix" this by making per-volume idempotency independent.

## 5. Pipeline B: jump-in-wiki (`jump-in-wiki.js`)

Per volume:

1. **Generate** `wiki.md` + `shared-wiki.md` (context: the previous volume's `wiki.md` + `shared-wiki.md`):
    - an author agent (per-volume session, `maxSteps 40`). Stubs are pre-created for both files (a stronger name anchor than "create a new file", and a crashed run leaves identifiable stubs).
      Stale classic-named files (`jump-in-wiki-NN.md`, `jump-in-wiki-shared.md`) are deleted up front so agents can't audit garbage.
      When the glossary task has already written the volume's `glossary.md`, the author/validator/feedback prompts offer it as a **read-only canonical reference** so the shared wiki's "Glossary" section uses canonical renderings instead of model memory (drift guard).
2. **QA loop**: a validator agent writes `jump-in-wiki-validation-NN.md` (size-scaled step cap) → acceptance one-shot scores the wiki 0–100 → unless the rolling window of scores meets the criterion, the same author session applies the feedback.
3. **Two-tier idempotency**: if `wiki.md` + `shared-wiki.md` exist → skip generation, go straight to validation; if a validation report exists and passes acceptance → skip the whole volume.
4. **Handoff**: after the volume is settled (processed *or* skipped), the deterministic per-volume translation handoff is written (`chapters.json` + `translation-brief.md`, `utils/handoff.js` — best-effort, never fails the volume).
5. After all volumes: the **last existing** `<volume folder>/shared-wiki.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/shared-wiki.md`), mirroring the other root copies. Skipped for `--volume` runs (a single volume's snapshot would not be the series state). End-of-run summary counts the volumes that hit the iteration limit.

## 6. Pipeline C: character-voice (`character-voice.js`)

Per volume, in order — each volume's reference builds on the previous one's:

1. **Extract** — one-shot call: source text → JSON array of `{ type, character, quirkType, description, examples, ... }` entries for both voice quirks and POV analysis. Parsed by `parseVoiceQuirks` (tolerates markdown fences and prose).
2. **Compile** — the workflow first **copies the previous volume's `character-voice.md` into this volume's folder** (`seedVoiceReferenceFromPrevious`) and turns it into an inlined section map (`buildVoiceIndex` → `voiceIndexBlock`), then an author agent (per-volume session, step cap `voiceAuthorMaxSteps` → `authorMaxStepsFor(referenceBytes, sourceBytes)`) reads the source, the reference it is amending, and the extraction results, and produces two files:
   - `character-voice.md` — the cumulative character voice reference, **amended in place with `editFile`** (`voiceWriteInstruction`; the whole-file `writeFile` is forbidden from volume 02 on — see gotcha 64)
   - `pov-map.md` — the per-volume POV map (marker identification, narration type classification, POV assignments, free indirect discourse detection), **written whole**, because it describes only this volume and is not cumulative — which is also why it is the one file the seed deliberately does NOT copy
   The agent-mode turn prompts (author/validator/feedback) name every material at its real path — the previous volume's reference at `../<previous folder>/character-voice.md` (same convention as glossary.js) — so agents never have to guess where to read. A missing previous reference fails loudly (dry-run: warn).
   **After the compile pass and after every feedback pass**, the same deterministic carry-forward gate the glossary runs (`assertVoiceCarryForward` → `compareVoiceCarryForward`) checks that this volume's reference still holds every character section the previous volume's held. The unit is the `### Character` section keyed on `voicePrimaryName` — the heading with its bracketed aliases and persona tags removed (`如月雨露（ジョーロ）【俺人格】` → `如月雨露`) — because the persona tag is what a feedback pass is most likely to reword while leaving the entry intact, and a COUNT dropping cannot be explained by a rename. A loss fails the volume and moves the reference to `character-voice.md.rejected`. The chunked flow runs it **between chapters** (`guardVoiceCarryForwardAgainst`). Knob: `VOICE_CARRY_FORWARD_GUARD=false`.

3. **QA loop**: a fresh validator agent per iteration writes `character-voice-validation.md` (step cap `validatorMaxStepsFor`) → acceptance one-shot scores the reference 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies feedback (`character-voice-feedback.md`, step cap `voiceAuthorMaxSteps`, **patching in HIGH → MEDIUM → LOW order with `editFile`** rather than verifying everything and rewriting at the end). Same score-based acceptance criterion as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run). This is the stage where both QA-loop rules were measured (gotcha 65): a passing 76 used to buy its second sample with a 2.63M-token feedback pass that wrote nothing and an 8.4M-token re-audit of the unchanged document, and the flat `maxSteps: 30` is what stopped that pass at 46 tool calls before it had written anything.
4. After all volumes: the last volume's `character-voice.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/character-voice.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `character-voice.md` (cumulative snapshot), `pov-map.md` (per-volume), `character-voice-new.json` (extraction snapshot for the handoff), `character-voice-validation.md` (validation report), and `character-voice.md.rejected` (a reference the carry-forward gate rejected — kept as evidence, never read by the next volume).

**Cumulative invariant:** same as glossary — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences from glossary:** no research stage (quirks are text-intrinsic); produces two files instead of one; extraction and compilation are separate stages.

## 7. Pipeline D: style-guide (`style-guide.js`)

The 4th pipeline step — the "how do I write it" policy layer. The glossary says *what to call things*, character-voice says *how characters sound*, the wiki says *what is happening*; the style guide says *how source-language constructs are rendered in the target language* (honorifics, pronouns, sentence-ending particles, internal-monologue markers, onomatopoeia, interjections, POV/scene markers, tense, punctuation, wordplay, translator notes).

Per volume, in order — each volume's guide builds on the previous one's:

1. **Extract** — one-shot call: source text + previous `style-guide.md` → JSON array of `{ category, pattern, description, examples, frequency, notes }` entries (categories: `honorific`, `pronoun`, `particle`, `internalMonologue`, `onomatopoeia`, `interjection`, `povMarker`, `sceneBreak`, `tense`, `punctuation`, `wordplay`, `note`, `other`). Parsed by `parseStyleObservations` (tolerates markdown fences and prose).
2. **Compile** — the workflow first **copies the previous volume's `style-guide.md` into this volume's folder** (`seedStyleGuideFromPrevious`) and inlines its section map (`buildStyleIndex` → `styleIndexBlock`), then an author agent (per-volume session, step cap `styleAuthorMaxSteps` → `authorMaxStepsFor(guideBytes, sourceBytes)`) reads the source, the guide it is amending (at `../<previous folder>/style-guide.md` — same convention as the other tasks), and the extraction results, plus optional cross-references (the same volume's `glossary.md` / `character-voice.md` snapshots, read if present), and writes the cumulative `style-guide.md` — **amended in place with `editFile`** (`styleWriteInstruction`; the whole-file `writeFile` is only for the first volume). The guide is written in the **target language** (it is instructions for writing the translation), quoting source-language patterns inline.
   **After the compile pass and after every feedback pass**, `assertStyleCarryForward` → `compareStyleCarryForward` checks that this volume's guide still holds every `## ` category section the previous volume's held — a guide missing "Address & Honorifics" has lost everything inside it. A drop in the bullet-rule count is **reported, not failed**: the guide's content is free prose, and a guard that compares prose starts calling an improvement a loss (gotcha 65). A missing section fails the volume and moves the guide to `style-guide.md.rejected`; the chunked flow runs it between chapters (`guardStyleCarryForwardAgainst`). Knob: `STYLE_CARRY_FORWARD_GUARD=false`.

3. **QA loop**: a fresh validator agent per iteration writes `style-guide-validation.md` (size-scaled step cap) → acceptance one-shot scores the guide 0–100 → unless the rolling window of scores meets the criterion, a fresh author agent applies the feedback (`style-guide-feedback.md`, step cap `styleAuthorMaxSteps`, patching in HIGH → MEDIUM → LOW order with `editFile`). Same score-based acceptance as the other pipelines (the state file is saved on every iteration, including the accepting one, so accepted volumes are skipped on re-run).
4. After all volumes: the last volume's `style-guide.md` is copied to the series artifacts directory (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/style-guide.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `style-guide.md` (cumulative snapshot), `style-guide-new.json` (extraction snapshot for the handoff), `style-guide-validation.md` (validation report), and `style-guide.md.rejected` (a guide the carry-forward gate rejected — kept as evidence, never read by the next volume).

**Cumulative invariant:** same as glossary/character-voice — regenerating any volume sets `regeneratedAny` → all later volumes are regenerated too.

**Key differences:** single output file (no second per-volume file); no research stage; rules must be *actionable* (a concrete rendering decision — keep / drop / translate / adapt — with context and exceptions; vague guidance is a validation finding); undecidable constructs go to an "Open Questions" section with their context rather than being guessed.

## 8. Pipeline E: consistency-audit + translation handoff (`consistency-audit.js`, `utils/handoff.js`)

The final gate before translation. Runs after the four volume tasks in the
default pipeline (and is also available standalone).

**Consistency audit** — an audit agent (gated fs tools, `cwd` = the series
root, writes confined to the root; the four artifacts are read-only) reads
`glossary.md`, `character-voice.md`, `style-guide.md` and `shared-wiki.md`
at the series root and writes `consistency-report.md`:

- **PASS/FAIL verdict** — FAIL when any HIGH finding exists (or when fewer
  than four artifacts were audited — a partial audit is not a sign-off).
- **Severity-banded findings** (HIGH blocks translation / MEDIUM should fix /
  LOW cosmetic) with verbatim quoted snippets from both sides of each
  conflict, across: glossary ↔ shared-wiki Glossary section, glossary ↔ style
  guide, character-voice ↔ wiki, style guide ↔ voice reference, plus
  intra-artifact contradictions.

No QA loop (it is a one-shot audit over the final state, not an
iteratively-built artifact). **Idempotency**: content-based — the report
also writes a `consistency-report.md.provenance.json` sidecar carrying the
sha256 fingerprint of each of the four audited artifacts; the report is
skipped while all four fingerprints still match the current files (any
artifact regeneration invalidates it). A missing or corrupt sidecar falls
back to the legacy mtime check (report newer than all four artifacts).
`--force` re-audits. A missing artifact fails loudly
(naming the task to run first). A **FAIL verdict is logged loudly but does
not fail the task** — the report is the deliverable; a fixer re-runs the
offending task and re-audits with `--force` before translation.

**Translation handoff** (deterministic, no AI) — per volume, written by the
jump-in-wiki task on both the processed and skipped paths:

- `chapters.json` — the machine-readable chapter list (segment id, file,
  title, char count, reading order) that the translation stage names its
  outputs by.
- `translation-brief.md` — a one-page brief: what is **new** in this volume
  (the persisted `glossary-new-terms.json` / `character-voice-new.json` /
  `style-guide-new.json` extraction snapshots), the chapter table, and
  pointers to every per-volume + series-level reference artifact (missing
  ones struck through, so the brief doubles as a completeness check).

## 8.5. Pipeline F: the translation stage (multi-model)

The final stage turns the reference artifacts into the actual translation.
It runs **per chapter** (segment ids from `chapters.json` / the source
bundle — plain-text volumes are one `whole` segment, epub volumes their
chapters + interludes) and runs each step against its own **role endpoint**
(`TRANSLATE_*` / `VERIFY_*` / `EDIT_*` / `AUDIT_*` — a name for "who does this
job", never a model name; on a shared-port local setup the hooks decide which
container answers, docs/architecture.md):

| Step | Task | Endpoint (env) | What it does |
|---|---|---|---|
| 1 | `translate` | Index-Translate-35B-A3B (`TRANSLATE_*`) | Fresh translation per chapter, the model's canonical instTrans single-user-message prompt (no system prompt): a header naming genre and target language, a `【源文】` block, a numbered `【约束要求】` list of `【硬性要求】` (binary: terminology, correction tasks, passage scope) and `【注意】` (graded: house style, character voice, background, continuity) constraints, and the output-only suffix. Its own decoding (temp 0 / top_p 1.0 / top_k -1 / rep-pen 1.0), fast non-thinking mode by default — sent as `chat_template_kwargs {enable_thinking: false}`, which is the only switch that model's chat template reads |
| 2 | `translate-qa` (round N) | verify: `VERIFY_*` · retranslate: `TRANSLATE_*` | The batched QA loop (see the design notes below). Each round: a **verify batch** — source-anchored 0–100 score + severity-banded findings per chapter (against source + glossary + style rules + **story background** — shared wiki / volume wiki / POV map; the source outranks the wiki, wiki-only findings cap at MEDIUM); PASS ≥ `PASSING_SCORE`; unparseable = FAIL (fail-closed) — then ONE **batched `AUDIT_*` phase** containing both cross-checks (no extra container switch): the borderline **tiebreak** re-scores every chapter within `±VERIFY_TIEBREAK_BAND` of the passing score and averages the two scores, and the **cross-chapter audit** reads each volume's published chapters TOGETHER for the drift no per-chapter check can see — then a **retranslate batch** — every FAIL chapter, plus any PASSING chapter named by a HIGH cross-chapter finding, the findings injected as a numbered "fix these" task; the bad draft is **not** fed back, and where the findings quote locatable source spans only those passages are re-translated and stitched back (see "Targeted correction" below). Rounds repeat until every chapter passes (round N+1's verify only re-scores the chapters round N retranslated — idempotent skips for the rest) |
| 3 | `polish` | polish: `EDIT_*` · final audit: `AUDIT_*` | **Two-phase, batched, cross-model.** Phase A (per chapter, the `EDIT_*` endpoint): proofreading pass (thinking on) — **the polisher sees NO source text** — gated by the deterministic regression guard. Phase B (batched, on the second `AUDIT_*` endpoint): the cross-model final audit scores each candidate on the source-aware drift rubric; a FAIL re-polishes on the `EDIT_*` endpoint (findings injected) and is re-audited next round. Up to `POLISH_QA_MAX_ROUNDS` (default 3) rounds; on exhaustion the draft is kept (runs on whatever drafts exist — including round-cap FAILs) |

**Design notes:**

- **The QA loop is batched, not per-chapter** (`translate-qa.js`). The
  pre-production pipeline loops "translate → validate → apply validation →
  re-validate …" until the validator is happy with the accuracy; the
  translation stage mirrors it as `translate` → **N rounds of
  [verify batch → retranslate batch]** → `polish` (N =
  `TRANSLATE_QA_MAX_ROUNDS`, default 3). Batching is forced by the local
  setup: the Index-Translate and Qwen containers share one port (only one serves
  at a time; switching is expensive), so the loop never interleaves models per
  chapter — each half-round is a whole single-model task run, invoked
  through `withHooks()` so the per-batch model-switch hooks fire at every
  boundary. The hash-keyed idempotency (verification sidecar +
  `translation-state.json`) makes round N+1 re-do only what round N
  changed: unchanged drafts are verify skips, PASS chapters are retranslate
  skips. **Stop conditions** (checked in order, pure `qaLoopDecision` in
  `utils/translate.js`): **all-pass** (the validator is happy),
  **stalled** (a retranslate batch applied nothing — every FAIL chapter
  already carries exactly those findings, per the `findingsHash` skip —
  nothing new can be applied; a plain re-run is then a cheap no-op and
  `--force` retries), **round-limit** (N rounds ran; still-FAIL chapters
  keep their latest draft — polish still runs on them).
- **No per-chapter QA loop inside a batch.** Each half-round is still
  one-shot calls per chapter with deterministic (no-AI) gates — the
  multi-model chain *is* the quality control (a different model grades the
  work). `verify-translate` is default-ON;
  `VERIFY_TRANSLATE_ENABLED=false` disables it **and** `retranslate`
  **and** the `translate-qa` loop (they are one QA chain) — the pipeline
  degrades to translate → polish.
- **Per-chapter idempotency via `translation-state.json`** (per volume
  folder, fail-open like the rolling-state files): each chapter entry carries
  `sourceHash` (the chapter's source text), `contextHash` (sha256 of glossary
  + style rules + shared-wiki/volume-wiki/POV background + voice notes —
  regenerating any reference invalidates every draft), `draftHash`,
  `retranslated`,
  `findingsHash`, `polishedDraftHash`, plus `polishVerifiedDraftHash` /
  `polishScore` / `polishFindings` / `polishFindingsHash` (the drift
  inspector's verdict + retry feedback — a chapter is polish-up-to-date only
  when `polishVerifiedDraftHash === draftHash`). A changed source, a re-run of
  the glossary/style/wiki
  tasks, or a retranslate (which bumps `draftHash` and clears
  `polishedDraftHash`) makes the dependent steps re-run on the next pass.
- **Story background injection** — `loadVolumeReferences` (utils/translate.js)
  builds `background` from the volume folder's `shared-wiki.md` (the
  cumulative "series state through this volume" — the per-volume copy, NOT
  the series-root one, which would leak later-volume spoilers), `wiki.md`
  (this volume's own plot beats), and `pov-map.md` (all truncated). It feeds
  the translate/retranslate prompts' background task line AND the
  verify-translate prompt's [Story Background] section (a 5th audit
  dimension: consistency with established facts, with the source text as
  ground truth — a wiki-only finding is capped at MEDIUM so a stale wiki
  cannot fail a correct translation). `polish` deliberately gets no source
  text and no background (its role is surface cleanup of already-verified
  text — the source-free prompt keeps the polisher from re-translating; the
  source-aware drift inspector is the semantic backstop, see below).
- **Chapter splitting** — a chapter's part size is **planned in tokens** by
  `planChapterSplit` (both `translate` and `retranslate` call it, so the two
  cannot cut the same chapter differently), and the parts are then translated in
  order by `splitChapter` (paragraph-aware). Two independent limits, and the log
  names whichever one bound: **admission** (the server rejects
  `prompt + max_tokens > window`, so the configured output cap is part of the
  sum whether or not the model ever generates that much) and **feasibility**
  (the answer the part needs — source tokens × `TRANSLATION_OUTPUT_RATIO` × the
  thinking factor — must fit INSIDE that cap, or the generation is cut off
  mid-chapter). Each part after the first receives the previous part's ending
  (`TRANSLATE_CONTINUITY_CHARS`, default 400, `0` = off) as continuity context.
  The parts are concatenated back into the single draft — with a deterministic
  dedup backstop: when the model repeats the previous part's ending at the start
  of its reply (continuation behaviour), `stripContinuityOverlap` strips the
  duplicated prefix (exact match only, ≥50 chars — a legitimate re-phrase can
  never be mangled). `TRANSLATE_CHUNK_CHARS` is now a **ceiling only when it is
  explicitly set** (`translateChunkCap` returns `null` when unset and the token
  plan decides), and it is also the fallback when the role has no known window
  or cap. See gotcha 57.
- **Per-chapter concurrency (opt-in)** — the chapter loops of the three
  INDEPENDENT tasks (`verify-translate`, `retranslate`, `polish`) run through
  `runWithConcurrency` with the shared `STAGE_CONCURRENCY` limit (default 1 =
  serial — the local hardware runs one inference at a time; the legacy per-stage
  names `VERIFY_CONCURRENCY` / `RETRANSLATE_CONCURRENCY` / `POLISH_CONCURRENCY`
  / `AUDIT_CONCURRENCY` still override their own stage). Reports keep reading
  order (rows stored by index). `translate` stays serial by design: each chapter's
  prompt carries
  the previous chapter's ending as continuity context, so its chapters are
  chained. State/sidecar writes are concurrency-safe: each volume holds one
  shared in-memory object and every save serializes it whole (last write
  wins with the most complete data).
- **Deterministic QA** (`checkTranslationQa`, per draft, **multi-language**): the
  residue check is per PAIR (`residueRatio` — source script minus target script,
  so JA→EN counts kana+Han, JA→ZH only kana since Han is shared, KO→EN Hangul,
  ZH→EN Han), the length band is per PAIR (`lengthBands` — JA→EN 0.6–2.5, ZH→EN
  0.7–3.2, KO→EN 0.5–2.6; `TRANSLATION_LENGTH_RATIO` overrides), and term
  matching is word-boundary for space-separated sources (Korean) and substring
  for CJK. Hard fails — empty draft, source-script residue > 5% (the model echoed
  the source), length under the pair's truncation floor; warnings — residue > 0.5%,
  length outside the pair's band, glossary terms present in the source whose
  canonical rendering is absent from the draft. Per-volume reports:
  `translation-qa.md` (translate), `translation-verification.md`
  (+ `translation-verification.json` sidecar), `polish-qa.md` (polish).
- **Polish regression guard** — the polished text is only accepted when it
  passes the QA the draft passed **and** keeps the draft's glossary coverage;
  a guard failure becomes a numbered correction task for the next attempt
  (the deterministic half of the polish QA).
- **Polish final audit (batched, cross-model)** — the deterministic guard is
  lexical (it cannot catch a meaning shift), so a source-aware, **cross-model**
  final audit closes the semantic gap. It is **two-phase and batched** (the
  local containers share one port, so models are never interleaved per
  chapter): Phase A polishes every chapter on the `EDIT_*` endpoint (NO source
  text) and keeps only the candidates that pass the deterministic guard; Phase
  B runs the audit on the `AUDIT_*` endpoint — a SECOND endpoint, distinct from
  the polisher's — over the whole candidate batch (one endpoint switch, the
  `polish-audit` hook), scoring each on the drift rubric (diff-focused:
  the draft's own problems and surface improvements are not findings; the
  source is ground truth). PASS ≥ `PASSING_SCORE`;
  unparseable = FAIL (fail-closed). A FAIL is re-polished on the `EDIT_*`
  endpoint (the `polish` hook switches back) with the findings injected as a
  numbered
  "fix these" task (the retranslate pattern) and re-audited next round; up to
  `POLISH_QA_MAX_ROUNDS` (default 3) rounds. On exhaustion the polished text
  is rejected, the draft is kept (any polished file is dropped so the merge
  publishes the draft), and the last findings persist in the state — the next
  run re-audits with them, and `--force` gives a fresh stochastic attempt. A
  polished chapter is "up to date" only when
  `polishVerifiedDraftHash === draftHash` (set by Phase B, not Phase A);
  legacy polish state (no verified hash, pre-audit runs) gets its existing
  polished text audited on the first run after the upgrade instead of
  re-polished. `POLISH_VERIFY_ENABLED=false` gates the pass on the
  deterministic guard only (Phase A candidates are accepted without the
  cross-model audit).
- **The publish gate** — what `translation.md` is allowed to contain. A chapter
  that did not pass verification is published WITH A VISIBLE WARNING above it
  (`unverifiedMarker`: `> **⚠ UNVERIFIED** — … verification score 57/100 … Reason: …`),
  not quietly included and not quietly quarantined out: the reader of the book is
  told which parts of it the pipeline could not vouch for, and the pipeline does
  not lose the chapter. `mergeVolumeTranslationFiles` returns
  `{text, missing, unverified}` so the run summary and `translation-report.md`
  carry the same facts. A chapter with no text at all is reported as MISSING (or
  as EMPTY IN SOURCE when the book itself has a hole — see the empty-chapter
  note below).
- **The draft ratchet** — a chapter may only move FORWARD through the QA loop.
  `verify` records the best draft it has ever scored (`recordBestDraft` →
  `bestScore` / `bestDraftHash` / `bestVerdict`, plus a copy of the text in
  `translation-<id>.best.md`); `translate-qa` runs `applyDraftRatchet` after each
  retranslate batch, which restores that better text wherever the newest draft
  scored WORSE and re-points the verification sidecar at the restored draft's own
  verdict (so the next batch skips it instead of paying to re-grade identical
  text). Without this, a rewrite that made a chapter worse became the published
  translation. A restore is refused when the restore point is missing or no
  longer matches its recorded hash. When the ratchet rolls back EVERY failing
  chapter in a round, the loop stops with reason `no-improvement` — the next
  round would only repeat the same damage.
- **Deterministic-QA failures are repairable, not fatal** — a draft that fails
  the no-AI checks (source-script residue, truncation, empty) used to be thrown
  away, which meant the one artifact that could fix it (`retranslate`) had
  nothing to work from and the volume ended with holes. Now the draft is kept,
  the rejected attempt is quarantined to `translation-<id>.rejected.md`, the
  state records `qaFailed` + `qaFindings`, `verify` seeds the chapter's verdict
  from that record WITHOUT a model call, and `retranslate` treats it as a FAIL to
  fix. Completeness is asserted at the END of the task, so one untranslatable
  chapter no longer prevents the rest of the series from being translated.
- **Empty chapters are a source problem, not a translation problem** — a section
  that converted to nothing (a blank page, an image-only page, text in a
  structure the converter does not map) is flagged at extraction (`empty` /
  `bodyChars`, floor `SOURCE_EMPTY_SEGMENT_CHARS`), skipped by `translate`
  WITHOUT a model call (floor `TRANSLATION_EMPTY_SOURCE_CHARS`, deliberately much
  smaller so a genuinely short interlude is still translated), hard-failed by
  `checkTranslationQa` if a translation call is ever made against it, and
  reported as "EMPTY IN SOURCE" in `translation-report.md` and the volume brief —
  distinct from "MISSING (never translated)", which is a pipeline failure.
- **Chapter headings** (`headingForSegment`) — the merged volume prints a heading
  only when the segment has a REAL declared title AND the chapter text does not
  already start with one. File names and pipeline labels ("Part 3 of 12") are
  `syntheticTitle` and print nothing, and a title still written in the source
  script is refused (the translator rendered it its own way; printing the
  Japanese original above it puts a foreign line at the top of an English book).
- **Reference injection is relevance-ordered** — `loadVolumeReferences` injects
  the sections of the cumulative references (shared wiki, volume wiki, POV map,
  voice notes) that matter to the volume being translated, via
  `selectSectionsByRelevance`, instead of the first N characters. The artifacts
  are cumulative and section-organised, so "the first N characters" showed the
  state as of the EARLIEST volumes and the volume-1 cast; the further a series
  got, the less of its current state the translator actually saw. Which rule ran
  is part of the fingerprint (`REFERENCE_SELECTION_VERSION`), so changing it
  invalidates the drafts built under the old one (the safe direction, gotcha 27).
- **Per-chapter invalidation** (`chapterContextHash`) — the volume-level
  `contextHash` hashes six whole files, so editing one glossary term invalidated
  every chapter of every volume (on a 17-volume series: thousands of calls spent
  re-translating chapters that never contained the edited word). A chapter's own
  key is the non-glossary references (whole) plus the glossary rows THAT CHAPTER
  actually uses: edit a term it contains → invalidates; edit a term it never says
  → keeps its draft; regenerate the style guide / wiki / voice reference → every
  chapter invalidates, exactly as before. An entry written before the key existed
  falls back to the volume-level hash.
- **Cross-volume continuity** (`previousVolumeTail`) — a volume's first chapter
  is translated with the tail of the PREVIOUS volume's PUBLISHED text (polished
  text when it won the merge) as continuity context, labelled honestly in the
  prompt ("This text continues after <source>, which ended with: …"). The cue
  never claims a chapter follows one that failed: `prevChapterTail` carries WHICH
  chapter the tail came from.
- **The prompt budget** (`estimateTokens` / `fitPromptBudget` /
  `buildBudgetedTaskLines`) — every stage's prompt is fitted to the ROLE's own
  context window, and when something has to be dropped the drop is LOGGED and
  written into `translation-qa.md` under "Reference material the model did NOT
  see". Trimming priority (least useful first): voice notes → story background →
  style rules → continuity tail → glossary. Source text, verification findings and
  the instructions are never trimmed. A stage that silently truncated a glossary
  was a stage that silently ignored terminology law.
- **Per-role endpoint caps** (`roleEndpoint`) — `<PREFIX>_CONTEXT_WINDOW` and
  `<PREFIX>_MAX_TOKENS` override the global `AI_CONTEXT_WINDOW` / `AI_MAX_TOKENS`
  for one role, because the translation stage's models are not one model: the
  translator, the verifier, the polisher and the auditor each get their own
  request size. Every stage-start log names the endpoint, the model, the context
  window and where each came from (`describeEndpoint`).
- **Run estimate and heartbeats** (`previousRunThroughput` / `logRunEstimate` /
  `progressCounter`) — each stage reads the generation rate (`gen=<n> tok/s`)
  from the newest `<series>/.run/logs/*/summary.log`, prints an estimate before its chapter
  loop, and ticks a heartbeat through it. An un-monitored run must be able to
  tell "working slowly" from "hung".
- **Chapter-list consistency** (`checkChapterListConsistency`) — `bundle.segments`
  stays the source of truth for reading order (gotcha 20), but `chapters.json` is
  what the handoff published and what the report reads. When the two disagree the
  stage says so loudly (usually: the source changed and the wiki task has not
  re-run) instead of letting the paperwork describe a different book.
- **Rendering-variant scan** (`findRenderingVariants`) — free, no model: every
  glossary term used in a volume is checked against the PUBLISHED text for
  near-variants of its canonical rendering (a second rendering of the same source
  term = HIGH, spacing/hyphenation = MEDIUM, capitalisation or a plural alongside
  the singular = LOW). This is the most common drift class in a long translation
  and it is invisible to a per-chapter verifier, which never sees the volume.
- **The cross-chapter consistency pass** (`runVolumeConsistencyPass`, default-ON,
  `VOLUME_CONSISTENCY_ENABLED`) — every other translation check reads ONE chapter,
  which is the right shape for fidelity ("does this chapter say what its source
  says?") and the wrong shape for drift: a volume that renders one name two ways,
  states a fact in chapter 3 and denies it in chapter 9, or changes tense halfway
  through publishes chapters that each score 90 and a book that contradicts itself.
  This pass reads the volume's PUBLISHED chapters together, on the `AUDIT_*` role,
  **inside the same batch as the borderline tiebreak** — one container switch for
  both cross-checks, never interleaved with the verifier. It reads
  `resolvePublishedChapterTexts` (the merge's own rule), so the audit and
  `translation.md` cannot describe different texts. A volume larger than the
  auditor's context window is split into consecutive WINDOWS, each carrying the
  previous window's tail, and `volume-consistency.md` says plainly which chapters
  were never compared with each other. Findings are chapter-tagged
  (`FINDING [HIGH] chapters=ch3,ch9 — …` with both sides quoted verbatim); a HIGH
  finding makes even a 92-scoring chapter a retranslate target, and the draft
  ratchet guarantees a repair that scores worse is rolled back. A failed audit call
  is reported, not fatal: the volume keeps its per-chapter verdicts.
- **Targeted correction** (`TRANSLATE_TARGETED_FIX`, default-ON) — the findings
  quote short source spans, so a chapter with ONE bad sentence no longer gets
  translated again from scratch. `planTargetedRepair` locates each `Source: "…"`
  quote in the source (all whitespace removed on both sides, so a quote crossing a
  paragraph boundary resolves to both paragraphs), merges nearby spans into one
  passage, and the affected passages are re-translated and stitched back
  (`stitchParagraphs` — every untouched paragraph is kept byte-for-byte). The
  shortcut is REFUSED, and the whole-chapter pass runs, whenever the mapping is not
  trustworthy: the source and the draft do not have the same number of paragraphs,
  a finding quotes text that is not in the source (a structural finding), the
  affected span covers the chapter, or an affected draft paragraph is not a
  plausible rendering of its source span (a length-ratio check — the strongest sign
  the alignment is wrong). Each passage pass sees only the findings whose span
  lives in it (plus the chapter-wide ones, which are never silently dropped) and
  the neighbouring TRANSLATED text as the seam it must match. The stitched chapter
  is re-checked by the deterministic QA; a failure is quarantined to
  `translation-<id>.rejected-passage.md` and the whole-chapter pass runs.
- **The glossary disputes queue** (`utils/disputes.js`) — the one channel that
  carries findings BACKWARDS. The verifier reads the source, and sometimes what it
  finds is that the GLOSSARY is wrong rather than the translation. That used to die
  in a per-volume report while the retranslate pass went on obeying the bad entry
  and the next round complained again — an oscillation the round cap ended without
  ever telling the glossary. Now a `GLOSSARY DISPUTE:` block is parsed into the
  chapter's sidecar entry, aggregated by source term at the series root
  (`glossary-disputes.json` + `glossary-disputes.md`; the same term challenged in
  two volumes is ONE dispute with two pieces of evidence, and a report with no
  evidence never overwrites one that has it), and read by the glossary task's amend
  pass, which must settle each one — correct the entry, or record the evidence that
  makes the canonical rendering stand. Meanwhile the translator is TOLD the term is
  disputed while still being required to use it — the challenged terms are named in their
  own `【硬性要求】` line saying the rendering is under review, must still be used
  exactly as given, and is corrected in the glossary — so the loop cannot argue with
  itself, and the dispute is part of the
  chapter's invalidation key — only the chapters that actually use the term
  re-translate once it is settled.
- **Merge** — after every step, `mergeVolumeTranslationFiles` rewrites the
  volume's `translation.md` from the per-chapter files: the
  `polished-<id>.md` text wins when the state shows it was produced from the
  CURRENT draft (`polishedDraftHash === draftHash`), otherwise the draft. A
  polished file left over from an older draft is never published.
- **Endpoint sanity check** — every task calls `harness.assertModelServing`
  (`GET /v1/models`) before its first call and fails loudly when nothing is
  serving or the model id is missing — the loop re-checks before every
  batch. The task code contains **zero Docker
  logic** — on local multi-model setups the per-machine pre-hooks switch the
  containers (see docs/architecture.md "Pipeline hooks" and `hooks/README.md` Example 4).

**Artifacts per volume folder:** `translation-<id>.md` (draft per chapter),
`translation-<id>.best.md` (the ratchet's restore point),
`translation-<id>.rejected.md` (a deterministic-QA rejection, kept for diagnosis),
`translation-<id>.rejected-passage.md` (a targeted repair that failed the QA, kept
separately so both rejections survive),
`polished-<id>.md` (when the polish pass was accepted), `translation.md`
(the merged volume), `translation-qa.md` (including what the model did NOT see),
`translation-verification.json` + `translation-verification.md` (+ the volume-level
variant scan), `volume-consistency.json` + `volume-consistency.md` (the
cross-chapter audit), `polish-qa.md` + `polish-verification.json`
(the drift inspector's verdicts), `translation-state.json`.
At the series root: `translation-report.md` + `.json` (+ provenance sidecar) —
the deterministic roll-up of what the pipeline actually published — and
`glossary-disputes.json` + `glossary-disputes.md` — the open terminology challenges
the glossary task must settle.
All gitignored (generated output).

