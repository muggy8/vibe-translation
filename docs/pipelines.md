# The pipelines, one at a time

Sections 3.5 to 8.5: the extraction step, then glossary, jump-in-wiki, character-voice, style
guide, the consistency audit and handoff, and the translation stage.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

## 3.4. The order of these pipelines is a gate, not a convention

Since 2026-10-13 the order is declared data in `utils/prereqs.js` and enforced by a door on every
gulp task, before the task's own code is reached:

- `extract` needs `discover`.
- **glossary, jump-in-wiki, character-voice and style-guide each need `discover` + `extract` and
  nothing else** — so they may run in any order relative to each other, and a run that does them in
  a different order is not wrong.
- `consistency-audit` needs all four, because it is the check that they agree with each other.
- `translate` needs the intake, the extraction, all four references and the audit.
- `translate-qa` needs `translate`; `polish` needs `translate` **and** `translate-qa`.
- `verify-translate`, `retranslate` and `translation-report` are declared with no prerequisites:
  each is a half of the translation stage that only makes sense after `translate` has already run,
  and each is reached through it.

**"Complete" is read off the disk.** A prerequisite counts as finished when the files that step's
own declaration in `utils/artifacts.js` promises are there, in the shape that declaration says, and —
where the step grades its volumes — when the volume's persisted acceptance window still passes. A
`.rejected` file counts against the step **only when the artifact it names is gone**: a carry-forward
refusal and a failing grade both move the live file aside, so the missing file is what refuses the next
step and the quarantine is the sentence that says why. A `.rejected` lying beside the artifact it names
is the copy a re-render replaced — `npx gulp glossary --force` and every resumed volume leave one — and
it does not make the volume unfinished; a quarantined translate draft does not either, because keeping it
is how `retranslate` is meant to work. → gotcha 141.

**There is no override, and that is the owner's rule, not an omission.** `--force`, `--allow-fail`,
`ON_TASK_ERROR=continue`, the ledger and the resume menu are not read by the gate. The refusal is a
**structural** error, so no run policy walks past it; it costs no model call and writes nothing into
the series. `--allow-no-glossary` is **deleted** — "translate a volume with no glossary" is exactly
the case the gate now refuses, and an override for a case that cannot happen is a knob attached to
nothing. `--dry-run` prints what is missing and continues, because a dry run exists to show you that.

`--volume NN` narrows the check to the volumes the run is about to touch, so a series with a broken
volume 14 can still be worked on one book at a time.

### The other half: a finished translation freezes what it was built from

"May this step START?" is one question. "May this step REWRITE something a published translation was
already built from?" is the other, and the start-gate cannot ask it. Since 2026-10-13 the answer is
declared data in `utils/prereqs/freeze.js`, in the same closed folder and with the same rule: no flag,
no environment variable, no ledger entry and no run policy is an input to it, the refusal is
**structural**, it costs no model call and writes nothing into the series.

A volume is **frozen** when the `translate` step's own `required` per-volume artifacts are in its
folder — read from `utils/artifacts.js`, never from a second list. Eleven doors are covered: the five
pre-production steps, `discover` and `extract`, and the four manual doors (`rebuild-voice`,
`extract-voice`, `reopen-volume`, `attribute-voice`), which are root commands rather than gulp tasks
and so no wrapper can reach them.

**The freeze is on rewriting, not on looking.** The prerequisite gate runs `discover` and `extract`
before *every* step, so a freeze that blocked them outright would make a resumed run sitting in the
translation stage unable to run anything at all. A warm-cache `extract` verifies each volume's bundle
and rewrites nothing; `discover` reuses the plan of record; `consistency-audit` skips while its
provenance sidecar still fingerprints the four artifacts; and a glossary settlement whose every question
is already answered and whose render is byte-for-byte the `glossary.md` already on disk rewrites nothing.
All four keep running on a frozen series, and the offline pipeline loop's zero-call second pass is the
test that proves it.

So the question is never "is this step allowed to run?" but **"would this act actually rewrite it?"** —
answered by the same conditions `utils/series-run/skip.js` already uses to cancel its own skip
(`--force`, the cumulative cascade, a changed source fingerprint, a failing or missing acceptance
window). `missing-output` is the one cancellation that is **not** a rewrite: filling a hole in a
half-built volume is not overwriting something a translation consumed, and refusing it would make an
inconsistent series unrepairable. An unrecognised cancellation is treated as a rewrite, never waved
through.

`--volume NN` narrows this gate exactly as it narrows the start-gate: a frozen volume 01 does not block
a legal volume-02 run. `--dry-run` reports and does not refuse, which is the same rule the start-gate
keeps.

**There is a way past, and it is not a switch.** `npm run release-translation -- --volume=01,02
--door=glossary --reason="…"` records, in the run's own records, that those volumes' translations no
longer vouch for what the references now say. The reason is refused under 20 characters — the same
floor `reopen-volume.js` holds. It is per door (releasing `glossary` does not release
`character-voice`), it is standing rather than consumed, and **it does not delete, edit, mark or
schedule a single file in a translation folder**: the translations stay byte for byte, and what changed
is only what the pipeline is allowed to rewrite next.

→ `utils/prereqs.js`, `utils/prereqs/freeze.js`, `release-translation.js`, `gulpfile.js`'s
`withPrerequisiteGate` and `withFreezeGate`, `test/test-prerequisite-gate.js`,
`test/test-freeze-gate.js`, docs/map-helpers.md, gotcha 140, gotcha 142.

## 3.5. Pipeline 0: extract (`extract.js`) — check the books before anything is built on them

Per volume, and nothing else: **no model call, no prompt, no agent.** `npx gulp extract`, or
`npm run pipeline -- --stages=extract`, and it runs in the default run between `discover` and `glossary`.

1. **Resolve the volume's source** through the same `resolveSourceBundle` the other eleven callers use —
   the same door, the same cache, no second implementation of "is this extraction current".
2. **Say what happened to that volume's bundle**, per volume, in the log and in the report: **VERIFIED**
   (the bundle on disk matches the archive and schema 8 — nothing re-extracted), **RE-EXTRACTED** (a
   bundle was there and is no longer current), **EXTRACTED** (none existed yet), **READ** (a plain-text
   book has no cache to verify, and calling that "re-extracted" would report work that did not happen).
   The second run over the same 17 books reports **190 ms** and re-extracts nothing; a cold pass, measured
   on a copy whose extracted files had been deleted, is 2.2 s — and both passes report the same 133 chapters
   and 45,429 guides.
3. **Run the six deterministic checks** (`utils/source/audit.js` — `source-not-archive`,
   `no-usable-chapter`, `chapter-extracted-empty`, `title-is-filename`, `ruby-harvest-missing`,
   `guide-split-in-text`) and count what the volume holds: chapters, packaging groups, characters,
   pronunciation guides set aside, images.
4. **Write the record**: `extraction-<NN>.md` + `.json` per volume and `extraction-summary.md` + `.json`
   for the series, all under the run's own records folder (`.run/postmortem/`). **Nothing is written into
   a volume folder by this step** beyond the bundle files the extraction itself already writes, and every
   one of those names is one `intake/config.js` already recognises — which is what keeps the next intake
   run from mistaking a report for a book (gotcha 119).
5. **Then decide whether the series failed.** A HIGH finding throws a **structural** error — every volume
   audited and every report written first, because the audit costs nothing and one run should answer
   "what is wrong with my books?" for all of them — so `ON_TASK_ERROR=continue` cannot walk past a broken
   book and `glossary` is never started on text the audit already says is wrong. A MEDIUM is printed,
   counted and recorded, and the run continues. A volume whose archive will not open is named as a volume
   that could not be read, `**FAILED**` in its own report, and is fatal to the step.

Measured over a **copy** of all 17 real archives: 133 chapters, 109 packaging groups, 2,450,415
characters, 45,429 pronunciation guides, 457 images, **0 HIGH and 0 MEDIUM** — the six checks produce no
false positives on legitimate material. Measured on the offline loop's plain-text fixture: 2 volumes,
2 chapters, **0 HIGH and 2 MEDIUM** (`title-is-filename`, one per volume — a `.txt` book that declares no
heading of its own is titled after its file), and the loop continues.

What it does **not** do: it does not re-extract a warm cache, it does not repair anything it finds, it
writes nothing into a volume folder, and it is not the converter (`utils/source/extract.js` is). What it
**does** declare is its own record: `extraction-{installment}.md` / `.json` per volume plus the series
summary pair, in the `run` scope, all four `required` — the one pipeline step the delivery layer checks
its records against, and the only one (`test/test-delivery-audit.js` names it as the exception and pins
the other twelve steps to declare nothing — gotcha 127).

→ `extract.js`, `extract/`, `utils/source/plan/01-extraction-step.md`, `docs/map-core.md`.

## 4. Pipeline A: glossary (`glossary.js`)

**One route, no author agent.** The stage used to end with an agent that amended the document in
place, a validator agent that wrote the report by reading it, and a feedback agent that rewrote the
document on the validator's findings. All three are deleted, not deprecated: the glossary is
**rendered out of the volume's reference record**, the report is a query against that record, and one
grade decides the volume. The code is in git history at commit `294351c`. What follows is the one flow.

Per volume, in order — each volume's glossary builds on the previous volume's **record**:

1. **Open the volume's reference record** (`openGlossaryRecord`) before anything is written, with no
   setting in front of it. The previous volume's sealed record is copied forward (or an existing copy
   is topped up, never overwritten), and this volume's chapters are registered from the stage's own
   bundle segments — a store left to find its own chapters would find none for a plain-text volume and
   then refuse every citation it was asked to check. A record that cannot be opened **stops the
   volume**: the alternative is publishing a glossary with nothing behind it.
2. **Read the volume** — one tool-less one-shot per chapter-group: source + the previous volume's
   `glossary.md` → `{"terms": […], "revisions": […]}`, each term `{ term, rendering, note, type, query }`
   and each revision `{ term, rendering, note, quote, reason }`; parsed by
   `parseTermAnswer` (tolerates markdown fences, surrounding prose, and the bare array it used to ask for — a bare array carries no revisions). **`rendering` and `note` are on the list because
   the read pass is the only place on this route where a rendering is chosen** — the render cannot
   invent one, and the filing door refuses a row that arrives without it. When the previous glossary is over `GLOSSARY_TRUNCATION_THRESHOLD` the inlined copy goes through `truncateGlossary`: `GLOSSARY_TRUNCATION_MAX_ENTRIES` (200) full rows, chosen by whether the row's term occurs in the text being processed — matched under **any spelling the row names**, verbatim or by its Han-character skeleton, which is the only form in which two furiganed spellings of one term compare equal — and then the **complete term → rendering list of the whole file** (`buildGlossaryIndex`) appended underneath, so the window hides a row's Notes and never the existence of an entry. The extractor has no file tools, so that list is the only way its "do not re-propose what already exists" instruction can be obeyed (gotcha 82). The same prompt also carries the two notes the stage feeds back — the previous volume's zero-occurrence coverage audit (`buildUnusedEntriesNote`) and the open glossary disputes the translation stage raised (`buildDisputesNote`) — because the read pass is now the one place a contested rendering can be settled.
   **One read of that list is paid for at most twice** (`readTermList`, `EXTRACTION_MAX_ATTEMPTS = 2`, no
   environment knob): the run's own reasoning level, then `EXTRACTION_RETRY_THINKING_LEVEL` (`"medium"`, the
   same constant `character-voice/reading.js` chose by measurement). A read that throws, or whose answer
   `parseTerms` cannot read, is re-asked once; a read that hit the output cap is **not** re-asked (the same
   request at the same cap is cut off the same way) and is re-thrown, which is what the stage did before. A
   list that never arrived comes back `failed: true` with a named failure kind — never as `[]`, because `[]`
   is also the honest answer for a volume with nothing new, and the two used to look identical in the log, in
   `glossary-new-terms.json`, in the published file and in the coverage audit, which counts rows rather than
   reads. **The call asks for its own answer shape** (`termsResponseFormat`, declared beside `parseTerms`):
   an object root holding both lists — `{"terms": […], "revisions": […]}` — with every key the prompt names, the five closed
   `type` values, and `additionalProperties: false`. It is wrapped in an object rather than declared as a
   list because this endpoint refuses a `response_format` JSON Schema whose root is an array before it
   generates (HTTP 400 in 161 ms, 0 tokens, measured 2026-10-13 against the replayed request that lost volume
   01 chapter 5), and `ai/one-shot.js` refuses such a schema before it is ever sent. The envelope was then
   probed against the real endpoint on a short synthetic volume: **3,066 prompt + 2,290 completion = 5,356
   tokens, `finish_reason=stop`, 5 terms, all five parsed by `parseTerms`** (AGENTS.md gotcha 138).
3. **File what was found** — two filings from the same list, on purpose (`glossary/store.js`):
   - `fileGlossaryExtraction` files the read pass's terms as `extract`-stage **candidates**. They are never rendered; they are what makes "the glossary holds no row for a term this volume's read pass found" a query with a number in it.
   - `fileGlossaryTermRows` files the **published rows** — term, canonical rendering, note, section — each with its quote re-found in this volume's chapter files, and **refused when the rendering is missing** (`missingRendering`): an empty rendering column is a word on a list, not a decision a translator can use. This is the only thing in the stage that puts a rendering into the record.
   - `fileGlossaryRevisions` files the answer's `revisions` — this volume's replacement of a rendering an **earlier** volume published. It is the third filing door and the only one allowed to touch a term the record already holds, and it works by **adding a row, never by editing one**: the replacement carries `supersedes = the row it replaces`, and the replaced row's `status` becomes `superseded` in the same transaction, with every other column of the published row untouched. It **refuses rather than warns**, and the guard that decides is the evidence rule: **the line the revision quoted has to be in this volume's own chapter files** (`revision-quote-not-in-source`), because a rendering changed on the strength of the previous glossary's own row is a model opinion, not a finding. A refused revision files nothing and the term keeps the rendering it had; it is named in `glossary-validation.md` and on the console, and it is deliberately not a finding kind (gotcha 138).
4. **Research** the terms worth a lookup — **bounded, and with no agent in it** (`glossary/research.js`, `glossary/researchable.js`):
   - **Which terms**: the rows this volume's record just filed, narrowed by a rule that is a query over the record itself — the row sits in a world section (`Real-World References`, `Places`) **or** its own note declares an outside referent (`Real …`, `Parody of`, `Allusion to`, `the real <Proper Noun>`, `cf. real`), **and not** its note says this series made it up (`coined`, `in-series`, `in-world`, …). A row an earlier volume published is not re-researched. Measured against the 554 rows of the tagged real cumulative glossary: **126 researchable, 428 skipped**; the false positives and the false negatives are both named in `glossary/plan/01-glossary-route.md` §5.
   - **How many**: `RESEARCH_MAX_TERMS_PER_VOLUME = 12` — a constant in `glossary/researchable.js`, **no environment knob** (AGENTS.md rule 3). A volume that hits the cap prints what it skipped, in the log and in its own step report.
   - **What one turn costs**: a Wikipedia lookup made **by code** (`research.js`'s `researchTerms`, reached through an injectable `defaultWikiLookup`, which is why `research.js` itself needed no edit and why the offline suite can stand a fixture where Wikipedia stands), then **one tool-less one-shot** that reads the extracts and answers `{found, page, lang, url, note}`. No agent handle, no file tools, no `maxSteps`, no placeholder to edit, and nothing runs in parallel — the endpoint answers one request at a time (AGENTS.md §7).
   - **What it costs when it finds nothing**: a `found = 0` answer is still filed and still costs the one reading call it took, because "somebody looked and the lookup was empty" has to be distinguishable from "nobody looked". A term the lookup could not even reach costs no model call at all.
   - **Where the answer goes**: `fileResearchNote` writes it into the volume's record as a row of its own (`research_notes`, schema v8) keyed to the term and owned by the asking volume. **The glossary row it is about is never edited** — the render is where the two meet (step 5). A note for a term the record has no row for is refused.
   - `glossary-research.md` is now **the log this pass writes itself**: what it asked, what the lookup returned, what the reading call said, what the bound refused to pay for. The wiki stage still reads it.
5. **Render `glossary.md` out of the record** (`renderGlossaryArtifact`) — no agent writes the file, and nothing copies a previous volume's file in. The render prints the record's published rows **in force at this volume** (`publishedGlossaryRowsInRecord(store, {volume})`), section by section, under the title block `glossaryTitleBlock` supplies deterministically, merges each term's research notes into its Notes cell **at render time only** — the row's own stored body is never rewritten, because a published row is not edited, and a note folded into the body would come back through the door that reads a published file into a record and be appended a second time — and prints **one row per term**: a term whose rendering a later volume replaced is printed with the replacement, and the superseded rendering moves into the Notes cell as `Earlier rendering: "…" (in force from volume N)`. "In force at volume V" is the row with the greatest `applies_from_volume` **still ≤ V**, and the bound is asked of a term's first row too, which is what lets a record that has reached volume 8 render volume 3's glossary as volume 3 published it rather than as volume 8 later corrected it. **A render with no rows refuses** (`glossary-render-has-no-rows`) and leaves the `glossary.md` already on disk where it is, rather than publishing an empty document over a real one.
6. **The carry-forward gate** (`assertGlossaryCarryForward` → `compareGlossaryCarryForward`, no model call) checks that the file the render just wrote still holds every term the previous volume's held. It is now the stage's **only** defence: nothing copies a previous document in any more, so the render is the thing that has to be proved not to have lost an entry. It compares entries at SPELLING resolution (`glossaryTermSpans`): a row's term column is often several source-language spellings of one entry written as `A / B / C`, and an entry counts as carried when every spelling it named is still present in some current row — as its own row, inside a longer (widened) one, or across several (a split row). The gate is about the terminology, not the formatting of the row that held it: widening a row with a new alias improved the glossary, and comparing whole cells as exact strings called that a loss and quarantined a volume 02 that had grown from 88 terms to 140 (gotcha 65). The third legitimate form is a **rename** — the row now names a different source-language spelling of the same thing; it counts as carried when the row still documents the earlier spelling (anywhere in the row, the Notes column's "also written …") or the row carries the same target-language rendering and that rendering is unique on both sides, and it is reported as `renamed` and logged by name (gotcha 68). A real loss **fails the volume** and moves the damaged file to a numbered `glossary.md.rejected` (`quarantineDamagedGlossary`, through the shared door in `utils/reference-store/quarantine.js`) so the next volume cannot read it — which is what makes the `ON_MISSING_PREVIOUS` cascade fire (see gotcha 64). The chapter-by-chapter route runs the same gate **between chapters** (`guardCarryForwardAgainst`), against the baseline captured before each chapter, because that is where the damage actually happened. Knob: `GLOSSARY_CARRY_FORWARD_GUARD=false`.
7. **The deterministic audit** (`auditGlossaryArtifact`) writes `glossary-validation.md` from queries against this volume's record — same file name, same reader, same `**Recommendation:**` line the delivery layer and `test/prompt-audit.js` read. The questions the validator agent used to answer by reading the file are queries: does the record hold a row for a term its own read pass found, does every filed row's quote appear in the book, is any line too long for an agent's file tools to read, which characters does the record's roster hold. It also carries `extractionReadReport`'s block whenever a read of this volume's term list failed or needed its second paid read — a table of every read, how many paid reads it took, and **NOTHING READ** beside the ones that never produced a list — and emits a HIGH `chapter-extraction-never-answered` finding for each of those, because a glossary is copied forward and the terms a failed read was owed are missing from every later volume's too. That finding reaches the grader's report and the console; it does **not** yet reach the post-mortem's disk assessment, and `test/test-finding-routing.js` pins the gap rather than letting it be claimed. And it carries `revisionReport`'s block whenever this volume revised a term an earlier volume published or proposed a revision that was refused: the filed table (old rendering, new rendering, which volume it replaces, the line the revision came from, the reason) and every refusal named by the rule that refused it, deduped with how many times it was proposed. A refused revision is reported the same way the failed read is — in the report the grader reads and on the console, and **not** as a finding kind, for the same gotcha 138 reason.
8. **The acceptance grade** — the same rubric, the same two files handed to the grader (`glossary.md`, `glossary-validation.md`), the same rolling window and consensus gates as every other stage, with a bounded **sample** of the glossary chosen by code (`glossaryGradeSample`) and the audit's own statement of what it measured. **One iteration** (`maxIterations: 1`, a constant in `glossary/qa.js`) — and one iteration is not one *score*: acceptance still needs `ACCEPTANCE_MIN_SAMPLES` scores in its rolling window, and the shared loop collects the missing ones by re-grading the same artifact rather than paying for a round that could change nothing. A rendered document cannot change between two audits of the same record, so a second **iteration** would re-audit and re-grade identical bytes, and there is no author to hand the findings to. A failing grade moves the file to `.rejected`, leaves the record a **draft**, and throws, so the step runner's post-mortem and ticket machinery see it like any other failed step.
9. **Seal the record** (`sealGlossaryRecord`) as the last act of a volume the gate accepted. A volume the gate did not accept is left a draft, and the next volume's copy-forward refuses a draft with `reference-volume-unsealed` at HIGH (gotcha 102). The seal is per stage, not per volume: the character-voice stage seals the same record again at the end of its own work on it.
10. After all volumes: the **glossary settlement** runs (`glossary/settlement.js`, wired as the step's `afterVolumes`), and the series-root `glossary.md` is **rendered out of the settled reference record** — the newest row of every supersede chain — rather than copied from the last volume's snapshot. It asks which terms the settled record itself says are worth re-examining (a term whose rendering a later volume already replaced, or a term whose own note points past the volume that wrote it), pays at most `SETTLEMENT_MAX_TERMS_PER_RUN` (24, a constant, no knob) tool-less reading calls for the whole series, files a "change it" answer through the same revision door this stage uses, carries it to the settled record through the store's own top-up door, and then renders. **No per-volume `glossary.md` is rewritten.** Skipped for `--volume` runs and `--dry-run`, exactly as the copy was. It is a freeze door of its own (`glossary-settlement`, series scope): a series with published translations refuses it, and `npm run release-translation` is the only way past. → `docs/map-preproduction.md` (`glossary/settlement/`), `translate/plan/01-translation-route.md` §7 slice 4, gotcha 144, gotcha 145.

The extraction step also persists `glossary-new-terms.json` (the new-terms snapshot for the translation handoff), and after the volume is built a **deterministic coverage audit** (no AI) parses the glossary table and writes `glossary-coverage.md` + `glossary-coverage.json` (machine-readable sidecar) — per-term occurrence counts in the volume source (substring matching, the correct semantics for Japanese) plus the zero-occurrence terms (hallucinated-entry candidates; the next volume's extraction prompt is the half that acts on them).

**The chapter-by-chapter route is the same stage, not a second one.** `--chunked=glossary` — or a source too big for the stage's model window — reads one chapter at a time: extract → **file** → **research** → **re-render** → the between-chapter carry-forward gate, so the cumulative glossary reaches the next chapter's prompt through the record rather than through a document an agent edits. The order changed in glossary route slice 5: the research bound is a query over rows the record holds, so it can only run after the filing, and the answer has to be filed before the render can print it. Each chapter's research is narrowed to the terms that chapter just filed and spends from the volume's `ctx.researchTurnsLeft` — **the bound is per volume**, so a seven-chapter volume gets twelve research turns, not twelve per chapter. Only the **first** render of a volume moves an existing file aside; from chapter 2 on, the file being replaced is this volume's own previous render, and a pile of `.rejected` copies of one in-progress document is noise, not evidence. Its QA is the same volume-level gate the whole-installment route uses — the per-chapter validator agents, the findings-merge agent and the per-chapter feedback pass are gone with the author. → `glossary/store.js`, `utils/reference-store/pipeline-store.js`, gotcha 97, gotcha 102.

**What the stage no longer does, and what that costs.** It makes no author, validator, feedback or research-**agent** call: after glossary route slice 5 the stage opens **no agent handle at all** — it is one extraction one-shot per chapter-group, one tool-less research reading call per researchable term (up to `RESEARCH_MAX_TERMS_PER_VOLUME` per volume), and the grades. Measured in the offline loop, the glossary stage is **9 calls** where it was 15, and the chunked loop **27** where it was 39; slice 5 moves neither number, because both loops run with `RESEARCH_ENABLED=false` and the research pass is not in them. Two things the authored document had that the render does not: the **prose between the tables** (a style-policy paragraph, the "Series English title" line) is published only when the record backfilled it from an authored file, because `glossaryTitleBlock` supplies the title line, the canonical-renderings line and a line saying the file was rendered out of the record — and nothing else; and a **glossary dispute** can no longer be settled by editing a row — it is handed to the read pass instead, and settling one through the store's own challenge door is not built. What the render buys is the failure mode the author route could not survive: a reply cut off part-way deleted every entry it never reached from the series, and a deterministic render cannot do that. The entry-for-entry comparison against the authored artifacts is in `glossary/plan/01-glossary-route.md` §6 row 2 — 0 sections lost, 0 prose lines lost, 0 extra entries, and every missing entry a row the store's own evidence rule refused at filing.

Artifacts per volume folder: `glossary.md` (the rendered cumulative snapshot), `glossary-new-terms.json` (extraction snapshot), `glossary-research.md` (the research log the pass writes itself: what it asked, what the lookup returned, what the bound refused to pay for), `glossary-validation.md` (the deterministic audit the grader reads), `glossary-validation-rolling-state.json` (the acceptance window this volume was accepted on), `glossary-coverage.md` + `glossary-coverage.json` (deterministic coverage audit), `series.db` (the volume's reference record — the source the glossary is rendered from), a pipeline-written `.gitignore` whose whole content is `*.rejected*`, and `glossary.md.rejected` / `glossary.md.rejected.2` … (a glossary a gate rejected — kept as evidence, numbered, never read by the next volume).

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

**One route, no selector.** The stage used to have a second one — an author agent that compiled the
reference from the extraction and rewrote it on feedback, with a whole-installment-vs-chapter-by-chapter
decision in front of it and `--route=author` in front of that. It is removed, not deprecated: `--route=`
is refused for every value, with a message that names what replaced it. The code is in git history at
commit `75e59a7` if it is ever needed again. What follows is the one flow.

Per volume, in order — each volume's reference builds on the previous one's:

1. **Open the volume's reference record** (`openVoiceRecord`) before anything is written. The previous
   volume's sealed record is copied forward first, and that copy is where the hard stop lives: a volume
   whose reference lost characters this volume's own text contains is not carried forward, with no
   exception and no downgrade. It is not behind a setting — the artifacts are rendered out of this record,
   so a switch in front of it would not turn a check off, it would turn the volume off.
2. **Read the volume chapter by chapter** (`character-voice/reading.js` — the same pass
   `extract-voice.js` runs). One extraction one-shot per chapter: source text → `{"entries": […]}`, each
   entry a `{ type, character, quirkType, description, examples, … }` record covering both voice quirks and
   POV analysis, parsed by `parseVoiceQuirks` (tolerates markdown fences, prose, the bare array it used to
   ask for, and the `{"voice": […], "pov": […]}` split a model reaches for when a prompt opens by telling it
   to "produce two outputs"). The shape it asks for (`voiceResponseFormat`) is **open on purpose** — it names
   a key inventory and requires only `type`, and it is the one envelope of the three that is not closed; the
   reason is in `character-voice/stages.js` above the declaration (AGENTS.md gotcha 138). Each chapter's answer is
   kept in its own partial tagged with a fingerprint of the text it was read from, so a chapter already
   read for the same text is not paid for twice. An answer whose array never reached its closing bracket is
   half an answer: it is named and re-read once at `EXTRACTION_RETRY_THINKING_LEVEL`, and a chapter still
   cut off after both paid reads is kept and printed as **INCOMPLETE** in the log, in
   `character-voice-reading.md`, and in the report the grader reads. Each chapter after the first is shown
   `buildAlreadyExtractedNote` — which characters and which claim kinds its earlier chapters produced, not
   the claim text — so "extract only what this chapter adds" is an instruction the extractor can follow.
3. **File what was found** (`fileVoiceExtraction`): the claims land in the record as `extract`-stage
   candidates, on the roster entry the record already uses for that character, and a claim whose quotes do
   not appear in this volume's text is refused and named rather than filed.
4. **Render both artifacts out of the record** — no agent writes either file. `character-voice.md` is the
   cumulative reference (every earlier volume's sealed claims plus this volume's adopted ones);
   `pov-map.md` is organised by chapter and is **cumulative** too, which is the shape that has room for the
   point-of-view claims a character section cannot hold. The adoption step is the same door
   `rebuild-voice.js` uses (`utils/reference-store/rebuild.js`), so the stage and the manual command cannot
   produce different references from the same record.
5. **The carry-forward gate** (`assertVoiceCarryForward` → `compareVoiceCarryForward`) checks that the
   rendered reference still holds every character section the previous volume's held. The unit is the
   `### Character` section keyed on `voicePrimaryName` — the heading with its bracketed aliases and persona
   tags removed (`如月雨露（ジョーロ）【俺人格】` → `如月雨露`) — and a name the record itself folded into
   another roster entry counts as carried when its survivor's section is present (gotcha 110). A loss fails
   the volume and moves the reference to `character-voice.md.rejected`. Knob:
   `VOICE_CARRY_FORWARD_GUARD=false`.
6. **The deterministic audit** (`auditVoiceArtifact`) writes `character-voice-validation.md` from queries
   against this volume's record, with the reading pass's report folded in so the grader can see how the
   volume was read. The questions the validator agent used to answer by reading the file are queries: does
   the reference cover every character this volume's own text contains (HIGH when this volume's extraction
   filed a claim about them or their name occurs in 3 or more of its chapters; a MEDIUM **mention** when
   neither holds); is any line too long for an agent's file tools to read (HIGH — the 54,341-character line
   that made volume 01's reference unreparable is measurable in one pass over the file); which claims the
   extraction found and the published reference never took. It also writes `character-voice.md-audit.md`
   beside the artifact it judges, the way `rebuild-voice.js` has always written it (gotcha 119).
7. **The acceptance grade** — the same rubric, the same three files handed to the grader
   (`character-voice.md`, `pov-map.md`, `character-voice-validation.md`), the same rolling window and
   consensus gates as every other stage, with a bounded sample of the reference instead of the whole
   document. **One iteration, one grade**: there is no feedback pass, because there is no author to ask. A
   failing grade moves both artifacts to `.rejected`, leaves the record a draft — which is what the next
   volume's copy-forward refuses — and throws, so the step runner's post-mortem and ticket machinery see it
   like any other failed step.
8. **Seal the record** (`sealVoiceRecord`) as the last act of a volume the gate accepted. An unsealed
   volume is what the next volume's copy-forward refuses, which is the shape the "a damaged reference may
   not be carried forward" rule takes.
9. After all volumes: the last volume's `character-voice.md` is copied to the series artifacts directory
   (`SERIES_ARTIFACTS_DIR`, default `<SERIES_LOCATION>/character-voice.md`). Skipped for `--volume` runs.

Artifacts per volume folder: `character-voice.md` (the cumulative reference), `pov-map.md` (cumulative,
organised by chapter), `character-voice-new.json` (the extraction notebook, the input `rebuild-voice.js`
re-derives from), `character-voice-validation.md` (the report the grader reads), `character-voice.md-audit.md`
(the audit beside the artifact), `character-voice-reading.md` (only when a chapter had to be re-read or was
left incomplete), `series.db` (the volume's reference record), and `character-voice.md.rejected` /
`pov-map.md.rejected` (artifacts a gate rejected — kept as evidence, numbered, never read by the next
volume).

**What the stage no longer does, and what that costs.** It makes no agent call: the whole stage is one
extraction one-shot per chapter plus the grades. It does not decide a processing mode, so it no longer
prints the "this source is N tokens against an M-token allowance" line — its size guard is the reading
pass's cut-off detector, which catches the failure that line was a warning about rather than predicting it.
`--chunked` is accepted and announced as a no-op, because there is no second path to force onto a stage
that reads chapter by chapter whatever the volume's size. And the reference is no longer a document an
editor rewrites on feedback: one grade decides it, so a volume gets one grade instead of five and a failing
grade quarantines instead of buying a revision.

**`pov-map.md` means something different than it used to, and that changed before the removal did.** The
removed route wrote it per volume, whole, describing only the volume in front of it. The route that replaced
it renders it from the record, and the record is cumulative, so it carries every earlier volume's sealed
point-of-view claims in the order their own chapters appear. Translation context is not the reason:
`utils/translate/references.js` injects at most 2,000 characters of it, chosen by which sections the chapter
being translated matches. The reason to keep the change in view is meaning — a reader who expects
`pov-map.md` to be about *this* volume is reading a document that is also about every volume before it.
→ gotcha 109.

**Cumulative invariant:** same as glossary — regenerating any volume sets `regeneratedAny` → all later
volumes are regenerated too.

**Key differences from glossary:** no research stage (quirks are text-intrinsic); produces two files instead
of one; no agent turn anywhere in the stage.

### 6.5 The attribution door — `attribute-voice.js`, and the one question the record could not answer

A character-voice claim does two jobs at once and the record has only ever been able to answer one of them.
It says **who the claim is about** — the roster entry its bullet is filed under — and it quotes **words
somebody said**. A bullet about 三色院菫子 that quotes a line of narration is a correct bullet about the right
person quoting the wrong speaker, and a bullet under a name this volume's text never prints is a bullet whose
subject may not be in the book at all.

This is a **door, not a stage**. Nothing in the pipeline calls it, it is not in `index.js`'s step list, and
the character-voice stage's cost is unchanged by it: the stage still spends one extraction one-shot per
chapter plus the grades, and the offline call baseline (87 calls in the default loop, 39 in the
chunked-glossary loop) is exactly what it was.

**The deterministic half asks when the answer is in doubt.** `utils/reference-store/attribution.js` reports a
roster entry this volume filed claims under that this volume's own text does not measure as present. It does
**not** name a speaker, and that is the load-bearing decision: the obvious rule — a cast name inside the
cited line is the speaker — was run against both real records before any code was written and fires on **0**
of volume 01's character claims and **10** of volume 02's, and every one of those 10 is the *addressee*
(`「あすなろさん。君の気持ちは…」` is 秋野桜 talking **to** あすなろ). A check that names a speaker from inside
a quote is wrong on every example this corpus gives it.

Two more measurements shaped it. The doubt is asked against **the volume that established the claim**, not
the volume being audited: measured the naive way the rule catches 8 claims in volume 2's record, measured
against the establishing volume it catches **6**, all of them 蒲田's, and 0 in volume 1. And an absence can be
a blind spot: 蒲田 *is* in volume 2 — the book prints 蒲かま田た, with the reading aids written *between* the
two kanji — and the store's one matching rule needs a Han-character skeleton of 3 or more, so a two-kanji
name is invisible to it. A narrow probe (`namePrintedWithReadingAids`) searches the kanji in order with only
kana between them; swept over every cast entry both real records hold it fires on **1 of the 4 entries
measured absent** and **0 of the other 3**. It is deliberately **not** wired into `presence.js` or
`evidence.js`: widening the store's one matching rule to rescue one character is how a guard stops meaning
what it says, and the coverage rule and the copy-forward guard are built on that rule answering the same
question everywhere. `cast_alias` is the door that closes that case properly, and the report names it instead
of walking through it.

**The reading half is the only part that costs a model call**, and it is bounded four ways with no
environment knob on any of them: one call per doubted entry (not per claim, chapter or character),
`DETECTIVE_MAX_GROUPS` entries per run, `DETECTIVE_MAX_STEPS` **read-only** tool calls each, and
`DETECTIVE_TOKEN_BUDGET` prompt tokens per run after which the remaining entries are reported as unanswered
rather than paid for. The agent may read, in that volume's folder only; the write tools are not offered at
all. What it may not do is decide.

**What an answer does.** It is filed in `attribution_answers` (schema version 7), so the next run can tell
"nobody asked" from "somebody asked and agreed" and does not pay for the same reading twice — running the
command a second time over volume 02 costs **0 model calls**. An answer that agrees closes the question. An
answer that disagrees opens one `challenge_fact` row per claim, owned by the asking volume, each with its own
quote checked against the book, and the claim the reference already published is **not edited and not
moved**: it is marked `disputed` and stays exactly where it is until somebody closes the dispute with
`resolve_challenge`. A narrator answer files its challenger with **no roster entry at all**
(`key = null`, `extracted_as = "narrator"`), which is the record's existing shape for a claim whose subject it
refuses to invent — and since the coverage rule counts rows in `cast`, the narration is never asked to be a
character. An answer whose challenge cannot be filed leaves no answer row either: the whole thing is one
transaction.

**Severity, stated because a reader will want to argue with it.** An unanswered doubt is **MEDIUM**
(`reference-claim-attribution-in-doubt`): the record contradicts itself, and 蒲田's six claims are the case
where the contradiction is the measurement being blind rather than the attribution being wrong, so a HIGH
here would stop the next volume over a two-kanji name the store cannot see. A doubt somebody answered and
said the wrong thing is **HIGH** (`reference-attribution-contested-unresolved`) while its challenge is open:
the published reference is attributing those words one way while its own record disputes it, and that is
damage. A roster entry keyed by the word for the narration is **HIGH**
(`reference-narrator-counted-as-a-character`). An answered doubt with nothing contradicting it is not a
finding at all — but it is still printed in the report, because an answer of "the name is printed in a
spelling this record cannot see" closes the question without closing the blind spot.

**Measured on the real volume 02.** 1 group, 6 claims (3 published, 3 extraction candidates), all six quoting
dialogue. One model call: **8,208 prompt + 2,322 completion = 10,530 tokens**, 0 tool calls — the detective
answered from the passage handed to it. The answer was `confirmed` → 蒲田, with the line that settles it
quoted out of ch3:1243 (「私は……、一年の蒲かま田たです」) and ch3:1245's narration behind it. **No challenge was
opened, no row was edited, and the published `character-voice.md` and `pov-map.md` are byte-identical to
before.** The honest headline is that the check fired, the measurement is blind, and the attribution was
right. Re-audited through the stage's own door: 3 findings, 0 HIGH, 1,360 citations re-checked (down from 4
findings — the attribution MEDIUM is gone because the record now holds an answer), and three fresh acceptance
grades of **80 / 80 / 79**, all "Pass with minor edits", with the grader's notes naming the three remaining
MEDIUM findings instead of the 蒲田 contradiction. → gotcha 121.

## 7. Pipeline D: style-guide (`style-guide.js`)

The 4th pipeline step — the "how do I write it" policy layer. The glossary says *what to call things*, character-voice says *how characters sound*, the wiki says *what is happening*; the style guide says *how source-language constructs are rendered in the target language* (honorifics, pronouns, sentence-ending particles, internal-monologue markers, onomatopoeia, interjections, POV/scene markers, tense, punctuation, wordplay, translator notes).

Per volume, in order — each volume's guide builds on the previous one's:

1. **Extract** — one-shot call: source text + previous `style-guide.md` → `{"constructs": […]}`, each entry
   `{ category, pattern, description, examples, frequency, notes }` (categories: `honorific`, `pronoun`,
   `particle`, `internalMonologue`, `onomatopoeia`, `interjection`, `povMarker`, `sceneBreak`, `tense`,
   `punctuation`, `wordplay`, `note`, `other`). Parsed by `parseStyleObservations` (tolerates markdown fences,
   prose, and the bare array it used to ask for). The shape it asks for (`styleResponseFormat`) is declared
   beside that parser and closes the entry: every key the prompt names, the thirteen `category` values and the
   three `frequency` values as enums, `additionalProperties: false`.
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

**`translate/plan/01-translation-route.md` is the plan of record for rebuilding this stage onto
the reference record** (written 2026-10-13, **slice 1 built**, slices 0 and 2–5 not built). It
measures what the stage costs today for the first time — 17 volumes, 133 chapters, 2,450,316 source
characters, ~1,477,922 estimated source tokens, **133 translate calls with zero chapter splits**, the
binding limit being admission not feasibility, and **6 container switches on a clean pass / 23 on a
worst-case pass** — and records that **the cost of one switch has never been measured**, which is
why its slice 0 is a measurement and why the batching is deliberately not designed.

**Slice 1 closed the first of the two wiring gaps it named.** The translator no longer reads the
**volume folder's** `glossary.md`: `utils/translate/settled-glossary.js` reads the **settled
reference record** — the highest-numbered volume record on disk, asked for the rows in force at its
own volume, which is the newest row of every supersede chain — and `loadVolumeReferences` hands the
stage that render as the terminology law, naming the record it came from
(`refs.terminologySource`). A rendering volume 11 settled now reaches volume 1's chapters, and the
superseded rendering is offered to no prompt anywhere; it survives only in the record's chain and in
the published file's `Earlier rendering:` line. **A series with no readable record refuses
structurally rather than falling back to the markdown** (gotcha 119's shape), and no flag or setting
reaches that decision. The five other references — `style-guide.md`, `shared-wiki.md`, `wiki.md`,
`pov-map.md`, `character-voice.md` — are still read from the volume folder, deliberately: a settled
rendering is not a spoiler, but the series-root wiki is the LATEST volume's story state. At
translation time the stage also prints, with 0 model calls, every published `glossary.md` that
disagrees with the record it is about to translate under. → gotcha 143.

**The second gap is open.** The disputes the verify stage writes to `glossary-disputes.md` are read
by the translator and by the glossary's log and **resolved by nothing** — `resolveChallenge` has no
caller outside tests. Across all 17 glossaries the previous run produced, **2 of 555 distinct terms
changed rendering**. The door that lets a later volume replace an earlier volume's rendering **does
exist and works** (`fileGlossaryRevisions`, `glossary/store.js:326` →
`utils/reference-store/glossary-adapter.js:841-892`, gated on a quote from this volume's own book);
what the plan still finds missing is the **backward** half — nothing names the already-written
chapters a revision invalidates, which is slice 2's term→chapter index.

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
  `contextHash` hashes the whole references (five files plus the settled glossary render), so editing
  one glossary term invalidated every chapter of every volume (on a 17-volume series: thousands of
  calls spent re-translating chapters that never contained the edited word). A chapter's own
  key is the non-glossary references (whole) plus the glossary rows THAT CHAPTER
  actually uses: edit a term it contains → invalidates; edit a term it never says
  → keeps its draft; regenerate the style guide / wiki / voice reference → every
  chapter invalidates, exactly as before. Since slice 1 the glossary half of both keys is the
  **settled** render, so a rendering a later volume replaced invalidates exactly the chapters that
  print that term — including the chapters of the volumes that came first, which is the point, and
  which is also the price: a chapter already paid for under the old rendering is paid for again.
  An entry written before the key existed falls back to the volume-level hash.
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
  evidence never overwrites one that has it), and read by the glossary task and appended to the volume's
  **extraction** prompt, because the read pass is the one place a rendering can now be revised — settle
  the dispute by filing a corrected rendering for this volume, or bring the evidence that makes the
  canonical rendering stand. (It used to be handed to the amend pass, which edited the row; that pass is
  gone, and settling a dispute through the store's own challenge door is not built — see
  `glossary/plan/01-glossary-route.md` §7.) Meanwhile the translator is TOLD the term is
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

