# The glossary route — plan of record

**Status: a plan, not a build.** Nothing here is implemented. It is written now because the
series was reset to zero on 2026-10-12 (tag `pre-extraction-fix-2026-10-12` in the books'
repository), and the one thing that has ever stopped the glossary stage from taking the new
path — volumes already accepted on the old one — no longer exists.

It is the glossary half of the program in `character-voice/plan/04-implementation-plan.md`,
and it uses the same store, the same rules and the same gate. Where that document describes
why the store exists, this one describes how the glossary stage becomes a route over it.

**It depends on `utils/source/plan/01-extraction-step.md`.** Everything this plan renders is
built out of extracted book text, and the defect that made the old glossaries wrong was an
extraction defect, not a glossary one. That plan is separate because extraction is upstream of
*every* stage; the dependency runs the other way — the glossary rebuild should not start until
the extraction step has run over all 17 volumes and produced its numbers, or at minimum until the
extraction audit has been run and read.

---

## 1. Why this is being done

The glossary stage is the last agent-driven pre-production stage left in the pipeline, and it
is the only one whose cost has never been measured.

**What it does per volume today.**

| step | shape | measured? |
|---|---|---|
| extract terms | one model call | — |
| **research** | **one agent conversation per new term** | **494 conversations across the 17 volumes** (12–70 per volume) |
| **author** | an agent writes `glossary.md` through the file tools | tokens unmeasured |
| **validator** | an agent reads the finished glossary and writes a critique | tokens unmeasured |
| acceptance | one scoring call, 0–100 | — |
| **feedback** | on a failing window, a fresh agent rewrites the glossary | tokens unmeasured, and it repeats |

**The cost is unknown, and that is itself a finding.** The run that produced the 17 glossaries
(2026-10-09) predates the run memory that now lives beside the books, and no transcript of it
survives anywhere in either repository. The stage has never had a number attached to it. The
character-voice stage, which was rebuilt, costs about **1,000,000 tokens per volume** and makes
**no agent call at all**. The glossary is the only remaining stage whose price is a guess.

**And most of what research buys is nothing.** The cumulative glossary volume 17 published held
468 entries in seven sections:

```
Terms & Concepts          218
Character Nicknames        73
Items & Artifacts          73
Characters                 63
Real-World References      66   ← the only section an outside lookup can inform
Places                     51
Factions & Organizations   24
```

A research agent was paid for every new term. **402 of 468 entries are things this author
invented** — a nickname, a club, a school rooftop, a fictional technique. There is no article
about them. The 66 real-world references are where the money should go, and they are 14% of
the artifact.

---

## 2. What must not change

These are the rules the store already enforces, and a glossary route that weakens any of them
is not a cheaper glossary, it is a worse one.

1. **A term with no checkable quote is not a glossary entry.** Every row goes through
   `verifyEvidence`; the quote is re-found in the volume's own chapter files.
2. **A row belongs to the volume and stage that wrote it.** After that volume's record is sealed
   the row is contested or superseded, never edited or deleted.
3. **The previous volume's record is copied forward, checked, and recorded inside the copy.** A
   volume cannot be built on a reference that lost characters or terms it names.
4. **Damage to a reference stays a hard stop.** The lost-coverage finding is HIGH and blocks
   copy-forward, with no exception and no downgrade.
5. **The artifact is cumulative and amended, never silently reproduced.** Whatever the previous
   volume published must still be there.
6. **The acceptance gate keeps its shape.** Same rubric, same report file name, same
   `**Recommendation:**` line, same quarantine on failure — `test/prompt-audit.js`'s
   `acceptance-context` rule and the delivery layer both read those.

---

## 3. The route

Six steps, and the model is asked exactly twice per chapter-group: once to read, once to grade.
**Built 2026-10-13 (slice 2), with one change to the plan.**

1. **Read the volume chapter by chapter.** One extraction call per chapter, in reading order,
   each told to report only what this chapter adds to what the earlier chapters already filed.
   This is `glossary/chunked.js`'s existing per-chapter extraction. **It is not unchanged:** the
   answer now has to carry `rendering` and `note` beside `term`, `type` and `query`. The plan said
   the extraction contract would not move, and that was wrong — the read pass files its terms under
   `source_stage: 'extract'`, which `renderGlossary` deliberately excludes, so with the author deleted
   and nothing else changed the stage published an **11-byte** file. The read pass is the only place
   left that can choose a rendering, so it has to be asked for one. A row that arrives without a
   rendering is refused at filing (`missingRendering`) rather than published as an empty column.
   **And for this series chapter-by-chapter is not a fallback — it is the only route.** Measured
   2026-10-13, every one of the 17 volumes is over the allowance (volume 01 is 99,573 tokens against
   65,484), so the whole-installment path runs only on the offline loop's deliberately small fixture
   book. The allowance is `window × 0.75 − the reply cap − the chat template`, and the reply cap in
   force is 131,072, not the derived 65,536 (gotcha 24); both figures are pinned by
   `test/test-tokens.js` §6b so they cannot be confused for each other again.
2. **File what was found into the volume's record.** Each term becomes a row with its quote,
   checked against the book as it is written. Already built, and now unconditional (slice 1). Filed
   twice on purpose: once as the read pass's **candidate** (`extract` scope, never rendered) and once
   as the **published row** (the document scope, with its rendering) — the candidate is what makes
   "the glossary holds no row for a term this volume found" a query with a number in it.
3. **Render `glossary.md` out of the record.** `renderGlossary` already exists in
   `utils/reference-store/glossary-adapter.js`, is tested for a byte-clean round trip, and is
   deterministic across processes. **It is now the published file** (`glossary/store.js`'s
   `renderGlossaryArtifact`, called by both routes). A render with no rows refuses
   (`glossary-render-has-no-rows`) and leaves the `glossary.md` already on disk where it is.
4. **Audit by query.** The deterministic audit writes the same report file, from queries instead of
   from an agent reading the artifact. The flag that used to gate it is gone (slice 1).
5. **One acceptance iteration.** The acceptance call stays. It is shown a bounded sample chosen by code,
   with a line saying it is a sample. `maxIterations: 1` is a constant in `glossary/qa.js`, not a setting
   — and one iteration is not one score: the shared loop still fills its `ACCEPTANCE_MIN_SAMPLES` window,
   and on this route it does that by re-grading the same artifact rather than paying for a rewrite round
   that could change nothing.
6. **Seal.** The volume's record is sealed when the grade passes, which is what lets the next
   volume copy forward from it.

Research sits between 2 and 3, and §5 is about what it becomes. The chapter-by-chapter route keeps the
between-chapter carry-forward gate by re-rendering after every chapter; only the first render of a
volume moves an existing file aside, because from chapter 2 on the file being replaced is this volume's
own previous render.

---

## 4. What gets deleted

Not deprecated — deleted, the way the character-voice author route was, with the commit hash
recorded so it can be read in history.

- The setting that switched the glossary stage's reference record on, and the loop flag that
  pinned it. **Deleted in slice 1, 2026-10-13.** The setting existed because a stage that had never
  run a real volume through the new path keeps the old one, and switching it mid-series strands every
  already-accepted volume (`AGENTS.md` gotcha 97). **Both of those reasons are gone:** the corpus was
  reset to zero on 2026-10-12, so no volume is accepted on the old path, and the offline loops have run
  the new path end to end. A flag with no reason is a way to turn a guard off. The loop flag is
  refused by name rather than ignored, so whoever types it is told what replaced it.
- The author agent and its turn. **Deleted in slice 2, 2026-10-13**: `glossary/authoring.js`,
  `glossary/amend.js`, `glossary/prompts.js` and `glossary/carry-forward/seed.js` (the step that copied
  the previous volume's file in so an agent could edit it), plus the orphan prompt pairs
  `system-prompts/glossary.md`, `glossary-validator.md`, `glossary-feedback.md` and their three
  `user-prompts/` counterparts. The code is in git history at commit `294351c`.
- The validator agent, the per-chapter validator partials, and the findings-merge agent. **Deleted in
  slice 2**: the chapter-by-chapter route's QA loop (`runChunkedQaLoop`) is gone, and both routes end at
  the one volume-level gate in `glossary/qa.js`.
- The feedback pass, and with it the rolling-window re-grades and the consensus confirmations
  that exist to decide whether to send feedback to an author. One grade per volume, as the
  character-voice stage does. **Done in slice 2**: `maxIterations: 1` is a constant, `maxValidationIterations`
  is out of `glossary/config.js`, and the feedback step is a log line. (The shared loop still collects
  `ACCEPTANCE_MIN_SAMPLES` scores in its rolling window — it re-grades the same artifact instead of paying
  for a round that would change nothing, which is why one *iteration* is not one *grade*.)

What is *not* deleted: the acceptance rubric, the quarantine door, the report's file name and
`Recommendation:` line, the carry-forward guard, and the store's own rules.

---

## 5. Research: bounded to the entries that are actually researchable

**Decision (account owner, 2026-10-12): research only the entries that are researchable.**

The record already classifies every entry — the section it renders under and its aspect. The
rule is therefore a query, not a guess: an entry is researchable when the book is not the only
place its meaning could come from.

- **Researchable:** the real-world-reference kind — a place, a work, a real practice, a term
  borrowed from the real world. 66 of 468 rows in the last published glossary.
- **Not researchable:** characters, nicknames, invented items, invented organisations, invented
  techniques, and the terms this series coined. 402 of 468.

Two things this decision has to settle before it can be built, both measurable and neither
settled here:

1. **The classifier has to be measured against the real 468 rows before it is trusted.** The
   section a row renders under is a good signal and a wrong one sometimes: an entry about a real
   Buddhist posture filed under *Terms & Concepts*, or a real city filed under *Places* that the
   book only uses as a joke. The measurement is: run the candidate rule over the tagged
   glossary, print what it selects and what it skips, and read both lists.
2. **Research results have to land in the record, not beside it.** Today research writes
   `glossary-research.md` and the author agent folds that prose into the glossary. With no
   author, a research result that is never filed is a result that never reaches the artifact.
   So research output must be filed as a note on the row it belongs to — and the render must
   print it. **This is the one genuinely new piece of work in the whole plan.**

---

## 6. Build order

Each slice is one worker session, ends with `npm test` green, and is checked against the disk
before it is reported as done.

**Slice 0 is not in this table:** it is the extraction step
(`utils/source/plan/01-extraction-step.md` §6), and it runs first. Clean extracted text is a
precondition of slices 1–6, not a task inside them.

**Where the comparison data lives:** the 17 authored glossaries, the 468 tagged rows and the
authored POV maps are in the **books' repository** (`/mnt/windows/weeb/oresuki`, a different git
repository from this one) at the tag `pre-extraction-fix-2026-10-12`. They are read with
`git -C /mnt/windows/weeb/oresuki show <tag>:<path>` — never by checking that repository out, and
never with `git add -A` there (`AGENTS.md` gotcha 10). Slices 2 and 5 both depend on this, and a
worker that does not know the two repositories exist will look for files that are not in this tree.

| # | slice | acceptance test |
|---|---|---|
| 1 | **Built 2026-10-13.** The record becomes unconditional: open it per volume, file the extraction's terms, seal after the grade. Delete the setting and the loop flag that pinned it. | **Met.** The store loop's glossary path *is* the default loop's glossary path — both open, file, audit, grade and seal every volume, and the default loop's glossary stage dropped its whole-document validator agent (21 calls → 15, and the whole loop 93 → 87). The setting's name appears nowhere in the repository except the suite that refuses the old flag and the index row the conductor writes. |
| 2 | **Built 2026-10-13.** Publish `renderGlossary(store)` instead of the author agent's file, and delete the author turn. | **Met, and the comparison was done first** (gotcha 120's guard held). Three real authored volumes compared entry-for-entry with **0 model calls**: volume 01 — authored 18,025 bytes / 87 rows, the render **byte-identical** (sha256 `d0c92311…f69028`); volume 02 — 28,605 → 27,715 bytes, 124 → 120 rows; volume 17 — 189,759 → 178,406 bytes, 554 → 520 rows. **0 sections lost, 0 prose lines lost, 0 extra entries on all three.** Every one of the 34 rows missing from volume 17 is a row the store's own evidence rule refused at filing: 23 hold a guide-split string the guide-free re-extraction no longer prints (`貞さだ○状態` → `貞○状態`, gotcha 123) and 11 name a term the book never prints at all. Chain across the 17 authored files: 5,392 rows parsed, 520 filed, 4,618 carried, 254 refusals. Pinned by `test/test-glossary-render-route.js` (8 scenarios, 65 checks), including the render being byte-identical **across two fresh processes**. |
| 3 | **Built 2026-10-13, inside slice 2.** Delete the validator agent, the per-chapter validators and the findings-merge agent. | **Met.** `glossary-validation.md` is still written, still named the same, still carries `**Recommendation:**`, and the prompt audit still passes (22 checks, 0 findings). The chunked loop dropped 12 calls (39 → 27). |
| 4 | **Built 2026-10-13, inside slice 2.** Delete the feedback pass and the re-grade machinery that feeds it. | **Met.** One acceptance *iteration* per volume in both loops (`maxIterations: 1`, a constant), and a failing grade still quarantines the file to a numbered `.rejected`, still leaves the record a draft, and still throws. |
| 5 | Bound research to researchable entries, and file what research returns onto the row. | The classifier measured against the 468 tagged rows, both lists read; a researched note survives into the rendered file. |
| 6 | Re-baseline the offline loops and the docs. | Both loops green with their new call counts written into the plan, and `docs/` describes the route that exists. |

---

## 7. The numbers this has to beat

| measure | today | target |
|---|---|---|
| research conversations, whole series | **494** | bounded to the researchable share of new terms |
| agent conversations in the stage, per volume | author + validator + feedback + per-chapter validators | **0**, plus bounded research — **met**: the stage's only agent turn left is the researcher |
| acceptance grades per volume | a rolling window with consensus confirmations | **1 iteration** (`maxIterations: 1`), which is not the same as 1 score: the shared loop still fills its `ACCEPTANCE_MIN_SAMPLES` window by re-grading the same artifact |
| model calls, offline whole-pipeline loop | 93 (validator-agent era) → 87 (slice 1) | **81**, glossary stage 9 (slice 2) |
| model calls, offline chunked-glossary loop | 39 | **27**, glossary stage 11 |
| tokens per volume | **still unmeasured** | at or below the character-voice stage's ~1,000,000 |
| a term that quotes a line that is not in the book | refused at filing | refused at filing |

**Slice 2 has to produce the first real cost number this stage has ever had.** Until it exists,
"cheaper" is a claim rather than a measurement, and this plan should not be called successful
without it. **Slice 2 did not produce it, and says so:** it was dispatched with a hard rule of **zero
real model calls**, so every number above is a **call count from the offline scripted loop**, not a
token count from the endpoint. The token figure needs one live volume, and that is a decision the
account owner makes, not a side effect of a refactor.

---

## 8. Open questions, said plainly

1. **Does the rendered glossary lose prose the authored one had?** — **Answered by slice 2, and the
   answer is "the rows no, the paragraphs yes".** This exact failure happened to the POV map: removing
   the author route silently dropped four summary sections worth 38% of that file's bytes, and it was
   caught only by comparing the two files afterwards (`AGENTS.md` gotcha 120). The comparison was run
   **before** the author was deleted, on three real authored volumes: **0 sections lost, 0 prose lines
   lost, 0 extra entries**, and volume 01's render is byte-identical to the authored file. What the
   render does not produce is described in item 5 below.
2. **What does a research note attach to?** A row, a section, or the volume? A note attached to
   nothing is a note that renders nowhere.
3. **Is one grade enough for a 468-row cumulative artifact?** The character-voice stage grades a
   rendered artifact once and accepts on a passing consensus. The glossary is larger and more
   mechanical. The sample the grader sees may need to be bigger than the one the flag-era code
   picks.
4. **The guides are gone from the text but not from the vocabulary.** 74 of the 561 rows the last
   cumulative glossary published held a pronunciation-guide string (`虹パ彩ン寺ジ菫ー` for
   虹彩寺菫). Those artifacts are discarded, so nothing needs repairing — but the term matcher
   and the evidence matcher should be re-measured against clean text before slice 1 is trusted,
   because both were tuned against dirty text. **That measurement now belongs to the extraction
   plan** (`utils/source/plan/01-extraction-step.md` §3, the guide-split and name-split checks),
   which turns it from a script somebody writes by hand into a step with a report. What stays
   here is the consequence: if that audit finds the matchers still tripping on clean text, the
   fix is in the matchers, and slice 1 inherits it.
5. **The prose between the tables is not published, and nobody decided whether the translator needs
   it.** The authored glossaries carry paragraphs that are not rows: a style-policy paragraph, the
   "Series English title" line, the occasional note that sits under a section before its table.
   `renderGlossary` prints the tables under a title block `glossaryTitleBlock` supplies
   deterministically (the title line, the canonical-renderings line, and a line saying the file was
   rendered out of the record), and the only way such a paragraph reaches the file is if the record
   **backfilled** it from an authored document through
   `ensureVolumeGlossaryInRecord`. On a series re-derived from scratch, none of it appears. Measured:
   volume 17's render is 11,353 bytes smaller than the authored file and 34 of its rows are missing,
   while 0 sections and 0 prose **lines the parser could see** were lost — the difference is the text
   between the tables, which the comparison counts as neither a row nor a section.
6. **A glossary dispute has no door any more.** `utils/disputes.js` still writes the queue and the
   glossary stage still reads it, but it now appends it to the **extraction** prompt instead of handing
   it to an agent that edits the row. Nothing in the store settles one: there is no term equivalent of
   `castAlias`/`challenge_fact`, no way to mark a published rendering contested, and no path from "the
   verifier quoted a line that contradicts this row" back into the record. The channel is currently a
   one-way notice. Deciding this is a slice of its own, and it is not in the build order yet.
7. **The 254 refusals are not all defects.** 23 hold a pronunciation-guide string the guide-free
   re-extraction no longer prints (gotcha 123's cost, which the account owner has to decide about) and
   11 name a term the book never prints at all. Whether a term the book never prints should still be
   published — it may be a real-world reference the author names without ever using — is a rule nobody
   has written, and today the evidence rule answers it by refusing the row.
