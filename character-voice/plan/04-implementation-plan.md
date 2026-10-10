# Plan: put a database behind the reference artifacts

**Status: PLAN — direction approved by the account owner 2026-10-10. Not implemented.**

This is the *why, what and when*. The design detail is in
[`03-database-backed-references.md`](03-database-backed-references.md); the failure evidence in
[`01-per-character-reference.md`](01-per-character-reference.md); the cost analysis in
[`02-compression-scheme.md`](02-compression-scheme.md).

**This plan supersedes item 5.1 of `IMPLEMENTATION-PLAN.md`** ("Structured artifacts +
deterministic merge", finding 12 of `PIPELINE-REVIEW.md`), which proposed the same idea as per-volume
JSON files and was deferred. §9 explains what changed and why the deferral no longer holds.

---

## 1. The problem, in one paragraph

Four pipeline stages build reference documents that **grow from volume to volume**, and each stage
builds the next volume's copy by handing the whole previous document to a model and asking it to
re-type it with this volume's findings added. That is the only way the current design knows how to
merge. It means the cost of a volume grows with the size of everything already accumulated, it means
every agent must hold a document larger than the book it is working on, and it means the model's
context limit becomes the binding constraint on the whole series — not on one unlucky volume, but on
all seventeen, increasingly.

It is what stopped the last run.

---

## 2. The evidence (measured, not estimated)

From run `delivery-2026-10-09T20-32-14-749Z`, volume 01, character-voice stage:

| | measured |
|---|---|
| tokens spent on **one volume's** voice reference | **171,843,556** |
| wall clock for that stage | **13 hours** (13:32 → 02:28 local) |
| the whole series' source text (17 volumes) | ~1,800,000 tokens |
| tokens re-sent to the model vs tokens it wrote | 166,711,658 : 5,131,898 = **32.5 : 1** |
| what the stage produced | 118,218 characters, from a 151,549-character book — **1.3 : 1 compression** |
| what the translator is actually allowed to receive | **4,000 characters** (`utils/translate/references.js:235`) — **3.4% of the artifact** |
| what one chapter's repair agent was handed | 274,128 characters — **1.8× the entire novel** |
| its reads / edits on one file | 24 reads, 29–40 edits |
| the longest line in the artifact | **54,341 characters — 157,566 bytes**; an agent may see 8,000 characters of a line (`envMaxLineLength`) and 65,536 bytes per read (`envMaxReadBytes`), so this one line is over both caps. (Re-measured 2026-10-10 against the file on disk: 106 lines, 118,218 characters, 336,428 bytes, longest line 54,341 characters at line 4. The 157,566 figure this row carried was the line's BYTE length mislabelled as characters — the same line, the wrong unit. Review 05 §2.2.) |
| the call that killed the run | `prompt (263012 tokens) leaves no room to answer in the context (262144)` |
| the grade it published anyway | **48 / 100**, passing score 69, published via `ON_QA_LIMIT` |
| volumes 02–17 | never started |

And the shape of the damage: the repair agents' cleanup edits used `oldString` containing the line
breaks on both sides with `newString: ""` and `replaceAll: true`, which **welded the document's lines
together**. Freshly written files in the same run are healthy (the validation report: 464 lines,
longest 4,494). Only the file that was amended in place was destroyed.

---

## 3. Why the earlier fix did not finish the job

`IMPLEMENTATION-PLAN.md` 5.2 (relevance-ordered selection) and 4.3 (per-chapter invalidation) are
done, and they fixed **which slice of an artifact the translator sees**. That was the right cheap
fix: it removed "the translator saw volume 1's state at volume 17" without changing any format.

It did not touch **how the artifact is produced**. The re-typing is still there, so the cost curve,
the context overflow, and the in-place-edit damage are all still there. The plan's own status note
says this, and names it as the next thing to take:

> "What is still open is the durability half: an agent re-typing a 1,200-entry cumulative glossary
> under an output cap, with another agent as the only 'no regressions' check. That is a real risk on
> a 17-volume series and it is the next thing this plan should take."

The last run is the evidence that it is not a theoretical risk.

---

## 4. What must be preserved — the benefits of the current system

This is the requirement the plan has to satisfy, not just the problem it has to fix. Everything below
survives.

| the current benefit | how it survives |
|---|---|
| **Pre-production artifacts exist and guide the translator** | `glossary.md`, `character-voice.md`, `style-guide.md`, `wiki.md`, `pov-map.md` keep their names, their locations and their shapes. They become **rendered output**, not hand-written input. The 105 references across 34 code files and 8 prompt files that read them by name are untouched |
| **They are validated before the translator trusts them** | Kept, and strengthened. Validation stops being "another model reads the document and forms an impression" and becomes deterministic queries plus a graded sample. Trust goes up, not down |
| **Every fact is checkable against the book** | New and stronger: a fact whose quoted evidence does not appear at the chapter and line it cites is **refused at insert**. Today nothing enforces this at all |
| **Knowledge accumulates across volumes** | Kept, by copying each volume's database forward. Volume 5's translator still benefits from volumes 1–4's reading |
| **Later volumes cannot spoil earlier ones** | Kept, and made structural. Today it is a convention (`docs/pipelines.md:186`); it becomes a fact about which file is open |
| **Nothing is silently lost between volumes** | Kept, and moved earlier: the "did a character vanish" check runs at the copy, which is the moment it would happen, and the copy can be refused |
| **Re-running finished work costs nothing** | Kept. `npm run pipeline-loop` already proves a second pass makes zero calls, and per-volume sealed files make the skip checks *more* precise, not less |
| **The QA loop, the acceptance grade, the delivery layer, the ledger** | Untouched. New deterministic quality signals are added to `utils/delivery-verify/signals.js`, not substituted for the existing ones |
| **The sandbox and the closed tool menus** | Extended, not weakened. The database gets named tools with a closed menu, exactly like the file gate; no agent is given SQL |
| **Multi-model checking** | Untouched |

**The one thing that changes in kind:** the artifacts stop being things a model writes, and start
being things code generates from data a model proposed.

---

## 5. How it solves the problem — cause by cause

| the cause of the failure | the change that removes it |
|---|---|
| an agent had to hold the whole growing document | nobody ever does. Merging is code; a repair agent queries one character |
| the artifact was re-typed every volume | it is **appended** to, and the append is validated by code |
| edits to a shared document shredded its structure | agents never edit the published file. Code writes it, so headings and line lengths are outputs of a function |
| the context window was exceeded | three separate guards: nobody holds large documents; reads are capped per turn; and the harness refuses a turn that cannot fit, **before sending it**. Today it learns this only after the server rejects the call (`isTooBigForOnePassError`, `ai/one-shot.js:259`), and the offload mechanism that would keep a long turn alive exists but is deliberately not offered to stage agents — the prompt audit states it plainly: *"62 stage agent turn(s) offered neither memory tool — their reading stays in context"* |
| the expensive chapter-by-chapter mode was forced by the global output cap | the reference stages get their own output cap sized to what they actually write, so the mode decision stops being driven by a ceiling they do not use |
| 32 tokens were re-read per token written | queries return rows, capped, instead of whole files |
| the loss guard was fooled by destroyed headings | the guard compares fact identities in a store |
| "systematic mis-dating of quirks across chapters" | a claim about chapter 3 quoting a line from chapter 7 is rejected by code before it becomes a fact |
| repair agents re-trod chapters 4–7 | they are scoped to a character or a chapter, and handed that chapter's own audit slice (42 KB) instead of the merged whole-volume report (245 KB) |
| a 48/100 artifact was published silently | deterministic structural gates run before rendering and `ON_QA_LIMIT` cannot overrule them |

---

## 6. Decisions taken by the account owner (2026-10-10)

| question | decision |
|---|---|
| one database for the series, or one per volume? | **One per volume, copied forward.** Volume N's file is a copy of volume N−1's, then volume N's agents add to it |
| committed with the books, or rebuilt? | **Committed**, in the volume folder beside the book |
| may an agent update what it wrote? | **Yes** — rows it owns, for the volume it is working on, while that volume is unsealed. Ownership is stamped by the harness at launch, never by the agent |
| may it delete? | **Only its own unsealed rows.** After sealing, facts are contested or superseded, never removed |
| may it read what it does not own? | **Yes**, within its volume's ceiling. Source-text reads get the same ceiling, or the file tools become a way around the spoiler guard |
| how much may an agent read? | **Tight by default**, escalated to the delivery layer as a bounded, logged grant. Generous when no delivery layer drives the run — but generous means "as much as this model can hold", never unlimited |
| which artifacts move in first? | **Both at once** — the glossary and the character-voice reference, on one store with two thin adapters |
| do the notes record what a change *means*? | **No.** Only what changed, with dates. See §7.1 |

---

## 7. Deliberately out of scope

- **The style guide and the jump-in-wiki.** Style rules are instructions, not facts, and the wiki is
  narrative. Neither fits a fact table cleanly. They stay document-shaped until the store has proven
  itself on the two artifacts that do fit.
- **The translation stage.** Translate → verify → retranslate → polish is not touched. This plan
  changes what the translator is *given*, not how it works.
- **No new dependencies.** `node:sqlite` (built in, verified working on this machine) and the existing
  `zod`.
- **No interpretation stored about characters.** §7.1.

### 7.1 The one decision that trades something away, and how we will notice

The owner chose: the notes record **what changed and when**, not **what the change means**.

Today's document can contain a sentence like *"this tracks her pulling away from him."* That is an
interpretation, and under this decision it is not stored. The translator is given the dated sequence:

```
chapter 1   she calls him てめぇ
chapter 3   she uses 君 once, in the polite refusal
chapter 7   君 becomes her default; てめぇ now marks anger
```

and is expected to understand what it shows.

**The consequence that matters:** with no interpretation stored, **the dates are the only thing
carrying the meaning.** A mis-dated fact is no longer a small error — it scrambles the one signal
that tells the translator a character is changing. That makes the evidence-verification rule (a fact
is refused unless its quote really occurs at the cited chapter and line) the most important rule in
the design rather than a nice guard.

**The mitigation, which costs nothing:** render each character's facts **in chronological order**,
never grouped by topic, and say so in the prompt. A change that is visible as a sequence is most of
the way to a change that is understood.

**How we find out if this was the wrong call:** add one line to the acceptance rubric — *if the
source shows a character's speech changing register across chapters, does the reference record the
change, and does the translation reflect it?* — and watch it across the first three volumes. If it
scores badly while everything else scores well, the decision was wrong, and adding a one-line meaning
per change is a small, contained fix. If it scores well, the cheaper design was right.

---

## 8. Build order

Nine slices. Each keeps `npm test` green on its own. Per gotcha 69, every test uses a throwaway
fixture series (`test/fixture-series.js`); none may reach the real 17 volumes.

| # | slice | done when |
|---|---|---|
| 1 | Probe `node:sqlite` | **Done 2026-10-10.** JSON1 works, `json_each` works inside a view, WAL works, `backup` is present, and the volume-scoped spoiler filter returns the right rows. Open sub-question: what to do about the `ExperimentalWarning` so it does not pollute `npm test` |
| 2 | `utils/reference-store/` — schema, migrations, repository API, **no agent tools** | **Done 2026-10-10; reviewed by `05-review-slices-2-5.md`.** Schema round-trips. A fact without evidence is refused. A fact whose quote is not at the cited line is refused. The database path follows `SERIES_LOCATION` and the volume, and never falls back to the repo (gotchas 79, 94). The banned-patch-path decision is made here, not later |
| 3 | Copy-forward as a **guarded step** | **Done 2026-10-10; reviewed.** A planted corrupt source file is refused and reported HIGH. A clean copy has identical row counts and records its source hash |
| 4 | Import both artifacts for one volume, **render them back** | **Done 2026-10-10; reviewed, and the review's corrections are applied.** Measured on the real volume 01: the rendered glossary is byte-identical to the file on disk except for the one row the store refused, and the character-voice reference reproduces its content (its line structure differs only where the file itself has a 54,341-character welded line) |
| 5 | Sealing and ownership | **Done 2026-10-10; reviewed.** An agent updates and deletes its own unsealed rows. The same call against another volume's row changes **zero** rows and returns a refusal naming the real owner and pointing at `challenge_fact`. After sealing, delete is refused |
| 6 | Replace the AI validators with queries + a graded sample | **Done 2026-10-10, behind `GLOSSARY_STORE_VALIDATORS` / `VOICE_STORE_VALIDATORS`, both default off.** Each planted defect is caught at the right severity — `test/test-reference-store-pipeline.js`, twenty scenarios, the shape `test/test-postmortem.js` uses. The whole-document validators make no model calls: on the offline fixture loop the glossary stage goes 21 → 15 calls and 186,301 → 116,602 prompt characters, the character-voice stage 22 → 16 and 221,281 → 157,828, the whole run 107 → 95 and 1,131,401 → 998,663, and the `glossary-validator` / `voice-validator` kinds (12 calls, 149,454 characters) stop existing. On the real volume 01, measured without a model call, one acceptance grade drops from 227,782 characters to 23,473 for the character-voice reference and from 31,763 to 17,472 for the glossary. **No real volume has been run through it yet**, which is why both flags default off (§12) |
| 7 | Give the pre-production agents the read and write tools, with budgets | Tested against the scripted endpoint in `test/fake-backend.js`, **including a model that asks for more than the window can hold — that grant must be refused, not honoured** |
| 8 | Two-tier injection into the translator | The card tier is never dropped. The full tier is ranked by appearance in the chapter. A volume-N translation cannot see a volume-N+1 fact. Bumped through `REFERENCE_SELECTION_VERSION` so dependent drafts invalidate deliberately (gotcha 27) |
| 9 | The repair loop as query-and-propose | A repair agent makes **no file edits** on a published artifact |

**Slices 1–5 are built, and they add a parallel implementation that no agent touches** — nothing about what a prompt
says or which calls the pipeline makes changes, so they can be merged and tested without any
behavioural risk. **Slice 6 is built too, and it does change which calls the pipeline makes** (the whole-document validators
stop running), so it ships behind two flags that both default off: the rehearsal is `GLOSSARY_STORE_VALIDATORS=1
VOICE_STORE_VALIDATORS=1 npm run pipeline-loop`, and the switch back is un-setting them (gotcha 97). **Slices 7–9 change what the agents are able to do.** Review gates accordingly: 1–5
are safe to merge on a green suite, 6 needs the cost and quality numbers checked, 7–9 need the flag.

**One-time cost to accept**, carried forward from 5.1: every existing `contextHash` and rolling-state
file invalidates once, which means one full re-verification. Budget for it explicitly.

---

## 9. How this differs from the deferred 5.1, and why

5.1 proposed per-volume JSON files — `glossary.json`, `voice.json`, `style-rules.json` — with agents
proposing deltas and code merging them. **The merge half is kept unchanged.** Three things changed:

1. **JSON files became a database.** A JSON file that an agent must read in order to propose a change
   to it is the same failure in a smaller hat: the agent still has to hold the whole thing. A database
   lets it read *the four rows it needs* and never see the rest. This is the difference between a
   smaller document and no document.
2. **Proposals became owned writes.** 5.1 had agents propose deltas. This adds who owns a row, when a
   volume's rows stop being editable, and the `challenge_fact` verb that lets a later volume say an
   earlier volume got it wrong without editing it. Without ownership, "propose a delta" quietly turns
   back into "rewrite the file".
3. **Evidence became mandatory and verified.** 5.1's data model had no evidence field. That is the
   single rule that makes the artifacts trustworthy rather than merely well-structured, and it is the
   thing the old system never had.

**Why the deferral no longer holds.** 5.1 was deferred because the truncation problem it was meant to
solve had already been solved more cheaply by 5.2. That is still true — 5.2 fixed the translator's
slice. But the run that stopped was not caused by the slice. It was caused by the production of the
artifact, which is exactly the "durability half" the status note left open. The reason to do 5.1 now
is not the translator's context; it is the pre-production agent's context, and that one has now
actually failed.

---

## 10. Success measures — the numbers this has to beat

**Enforced by construction** (a test proves it, or the write is refused):

- every published fact has evidence that verifies at its cited chapter and line — 100%, at insert
- no published artifact is ever edited by an agent
- no agent turn is sent to the model that cannot fit its window — refused **before** the call
- a volume-N translation cannot read a volume-N+1 fact
- a second pass over finished work still makes zero model calls

**Measured** (from `npm run pipeline-loop`, `test/prompt-audit.js`, and one real volume):

| today | target |
|---|---|
| 171,843,556 tokens per volume for the voice stage | **under 10,000,000** |
| 13 hours per volume for that stage | **under 1 hour** |
| 32.5 : 1 re-read to written ratio | **under 5 : 1** |
| 274,128 characters handed to one repair agent | **under 30,000** |
| 24 reads and 29–40 edits per chapter by one agent | **0 edits to a published artifact** |
| 1 context-overflow rejection (263,012 > 262,144) | **0** |
| 1.3 : 1 compression, 3.4% of it consumed | the artifact is not measured by size; the measure is **how much of what was stored reaches the translator that needed it** |

**Quality must not fall.** The acceptance grade and the median verification score for the first three
real volumes must be at least what the current design achieves on a volume it did not damage, and the
prompt audit must stay clean. A cheaper pipeline that translates worse is a failed implementation of
this plan, not a successful one.

### 10.1 What slice 6 measured, and what it could not measure

From `npm run pipeline-loop` (the two-volume offline fixture, `test/fake-backend.js`), flags off vs on:

| | flags off | flags on | change |
|---|---|---|---|
| glossary stage — calls | 21 | 15 | −6 |
| glossary stage — prompt characters | 186,301 | 116,602 | −69,699 (−37%) |
| character-voice stage — calls | 22 | 16 | −6 |
| character-voice stage — prompt characters | 221,281 | 157,828 | −63,453 (−29%) |
| whole run — calls | 107 | 95 | −12 |
| whole run — prompt characters | 1,131,401 | 998,663 | −132,738 (−12%) |
| tool calls | 48 | 40 | −8 |
| `glossary-validator` + `voice-validator` calls | 12 (149,454 chars) | **0 — the kinds no longer exist** | −12 |
| `acceptance` calls | 24 (98,565 chars) | 24 (114,759 chars) | **+16,194** |
| prompt audit | 22 checks, 0 findings | 22 checks, 0 findings | unchanged |
| second pass over finished work | 0 calls | 0 calls | unchanged |

Three things about those numbers, stated plainly:

- **The fixture cannot measure tokens or wall time.** The scripted endpoint returns fixed usage counts
  (`prompt=200` or `prompt=600`) and answers instantly, so the honest measures it gives are **calls,
  prompt characters and tool calls**. The 171,843,556-tokens-per-volume and 13-hours figures in the
  table above are real-run numbers, and slice 6 has not been run on a real volume. They stay open.
- **Acceptance got more expensive, not less.** The deterministic audit report is longer than the
  validator agent's report, and the acceptance grade is shown that report. On the fixture that is
  +16,194 characters across 24 grades; on the real volume 01 the same change *reduces* the grade
  sharply, because the grade is also shown a bounded **sample** of the artifact instead of the whole
  artifact: 227,782 → 23,473 characters for the character-voice reference, 31,763 → 17,472 for the
  glossary. On a small artifact the sample costs nothing and the longer report is a net increase; the
  saving is on the artifacts that are actually too big to read, which is the case this plan is about.
- **The removable bulk is exactly the validators.** 12 calls and 149,454 prompt characters disappear,
  and nothing else is added. The remaining stages are untouched: `jump-in-wiki` and `style-guide` still
  run their validator agents, because slice 6 covers the two artifacts the store holds.

Against the targets: **0 edits to a published artifact** is met and testable — the flag-on fixture run's
`glossary.md`, `character-voice.md`, `pov-map.md`, `glossary-coverage.md` and both extraction JSON files
are byte-identical to the flag-off run's. **Under 30,000 characters handed to one grading call** is met
on the real volume 01 (23,473). The token and wall-time targets, the re-read-to-written ratio, and the
quality floor need a real volume run with the flags on, which has not happened.

---

## 11. Risks, and what would prove this was the wrong call

1. **`node:sqlite` is experimental.** Mitigated by wrapping it in one repository module so the engine
   is swappable. The alternative — a native SQLite dependency — collides with "keep CommonJS, no new
   frameworks" and with running in a container.
2. **A query tool can recreate the thrash.** 24 reads of an unreadable file becomes 60 tidy queries of
   a readable one and the context still fills. Budgets, row caps and "here is the narrower query you
   wanted" are load-bearing, not polish.
3. **The temporal rules can be modelled wrong**, and a wrong rule either leaks a later volume into an
   early translation or starves a later translation of facts it needs. Both failure modes must be
   pinned in tests with real cases before slice 7.
4. **Two sources of truth drift silently** if rendering is not authoritative. Rule: the database is
   authoritative, the documents are generated, and a test asserts the round trip.
5. **`aspect` must be a closed vocabulary** or the store degrades into a pile of notes nobody can
   query.
6. **Doing both artifacts at once** means two carry-forward guards and two renderers change together.
   Mitigated by one store with two thin adapters, and by `npm run pipeline-loop` already exercising
   both.
7. **Decision A (§7.1) may turn out to be the wrong call.** The rubric line in §7.1 is the detector.
   If it scores badly, the fix is small and contained. If nobody adds that probe, the decision is
   never tested and the quality loss arrives quietly.

---

## 12. Rollback

The store ships **behind a flag**, and the current path stays intact until a real volume has run
through the new one. Slices 1–5 add a parallel implementation that no agent touches, so they can be
merged and tested without changing what any prompt says. Slice 6 changes which calls the pipeline
makes and is switched per stage. Slices 7–9 are switched on per stage, and switching the flag off
returns to today's behaviour with today's artifacts still on disk.

Volume 01's damaged voice reference is **not** repaired under the old design. Its reference is 96.6%
unused and its repair under the current shape costs another 172 million tokens. It is redone once,
after the store exists, using the per-chapter extract (1.1 million tokens, ten calls, which performed
perfectly) and the code merge.
