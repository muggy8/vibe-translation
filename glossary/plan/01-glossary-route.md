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

1. **Read the volume chapter by chapter.** One extraction call per chapter, in reading order,
   each told to report only what this chapter adds to what the earlier chapters already filed.
   This is `glossary/chunked.js`'s existing per-chapter extraction, unchanged.
2. **File what was found into the volume's record.** Each term becomes a row with its quote,
   checked against the book as it is written. Already built, behind `GLOSSARY_STORE_VALIDATORS`.
3. **Render `glossary.md` out of the record.** `renderGlossary` already exists in
   `utils/reference-store/glossary-adapter.js`, is tested for a byte-clean round trip, and is
   deterministic across processes. **It has no production caller today.** The author agent is
   what stands between the record and the published file.
4. **Audit by query.** The deterministic audit already replaces the validator agent behind the
   same flag: same report file, written from queries instead of from an agent reading the
   artifact.
5. **Grade once.** The acceptance call stays. It is shown a bounded sample chosen by code, with
   a line saying it is a sample.
6. **Seal.** The volume's record is sealed when the grade passes, which is what lets the next
   volume copy forward from it.

Research sits between 2 and 3, and §5 is about what it becomes.

---

## 4. What gets deleted

Not deprecated — deleted, the way the character-voice author route was, with the commit hash
recorded so it can be read in history.

- `GLOSSARY_STORE_VALIDATORS` as a setting. The flag exists because a stage that has never run a
  real volume through the new path keeps the old one, and switching it mid-series strands every
  already-accepted volume (`AGENTS.md` gotcha 97). **Both of those reasons are gone.** A flag
  with no reason is a way to turn a guard off.
- The author agent and its turn.
- The validator agent, the per-chapter validator partials, and the findings-merge agent.
- The feedback pass, and with it the rolling-window re-grades and the consensus confirmations
  that exist to decide whether to send feedback to an author. One grade per volume, as the
  character-voice stage does.

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

| # | slice | acceptance test |
|---|---|---|
| 1 | The record becomes unconditional: open it per volume, file the extraction's terms, seal after the grade. Delete `GLOSSARY_STORE_VALIDATORS`. | The store loop's glossary path *is* the default loop's glossary path; the flag's name appears nowhere in the repository. |
| 2 | Publish `renderGlossary(store)` instead of the author agent's file. | A rendered glossary and an authored one are compared entry-for-entry on a real volume, and every entry the authored one had is accounted for. |
| 3 | Delete the validator agent, the per-chapter validators and the findings-merge agent. | The report file is still written, still named the same, still carries `**Recommendation:**`, and the prompt audit still passes. |
| 4 | Delete the feedback pass and the re-grade machinery that feeds it. | One acceptance grade per volume in the offline loop, and a failing grade still quarantines and still leaves the record a draft. |
| 5 | Bound research to researchable entries, and file what research returns onto the row. | The classifier measured against the 468 tagged rows, both lists read; a researched note survives into the rendered file. |
| 6 | Re-baseline the offline loops and the docs. | Both loops green with their new call counts written into the plan, and `docs/` describes the route that exists. |

---

## 7. The numbers this has to beat

| measure | today | target |
|---|---|---|
| research conversations, whole series | **494** | bounded to the researchable share of new terms |
| agent conversations in the stage, per volume | author + validator + feedback + per-chapter validators | **0**, plus bounded research |
| acceptance grades per volume | a rolling window with consensus confirmations | **1** |
| tokens per volume | **unmeasured** | at or below the character-voice stage's ~1,000,000 |
| a term that quotes a line that is not in the book | refused at filing | refused at filing |

**Slice 2 has to produce the first real cost number this stage has ever had.** Until it exists,
"cheaper" is a claim rather than a measurement, and this plan should not be called successful
without it.

---

## 8. Open questions, said plainly

1. **Does the rendered glossary lose prose the authored one had?** This exact failure happened
   to the POV map: removing the author route silently dropped four summary sections worth 38% of
   that file's bytes, and it was caught only by comparing the two files afterwards (`AGENTS.md`
   gotcha 120). The glossary's notes column is the same kind of thing — free prose an agent
   wrote. **Slice 2 must compare a rendered glossary against an authored one before the author
   is deleted, not after.** The tagged commit `pre-extraction-fix-2026-10-12` holds 17 authored
   glossaries to compare against.
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
