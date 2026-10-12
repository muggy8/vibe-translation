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

### 7.2 Rebuilding a reference from its extraction output, and what it does not buy

Volume 01 is the case §7.1 was written for and the case the store was built to catch: its
`character-voice.md` is destroyed (106 lines, one line of 54,341 characters, 3 `###` sections for a
cast of 10, 7 characters with no voice claim at all) while its **extraction output is healthy** —
`character-voice-new.json`, 223 structured claims, produced for about 1.1M tokens. Re-importing the
destroyed file into the store faithfully reproduces the damage; rebuilding from the extraction does
not.

`voice-adapter.js` renders rows whose `source_stage` is not `extract`, because extraction claims are
**candidates** rather than adopted content. That filter is a guard, so it was not widened,
parameterised, or bypassed. What was added is a fourth kind of row — `source_stage = "rebuild"`,
stamped by nothing else in the repository — and a claim becomes renderable by being **adopted in the
open**: a named, deterministic, code-only step that re-runs the same evidence rule every other row
goes through. Promoting the extraction rows in place was rejected because it would collapse "what the
extractor found" and "what the document says" into one set of rows. The damaged file is never an input,
and it is moved to `character-voice.md.rejected` rather than overwritten. Sections and bullets are
rendered **in chapter order**, which is §7.1's mitigation applied to a file no author wrote. (The
candidates are now filed beside the adopted rows rather than absent from a rebuilt record — §7.4.)

**What volume 01 actually measured** (rehearsal against a copy under `/tmp/opencode/`, no model call,
nothing written into the series folder):

| | faithful import of the destroyed file | rebuilt from the extraction |
|---|---|---|
| claims the store accepted | 15 voice rows, plus the volume's 216 extraction claims filed alongside them the way a real run files them | **214 of 223** (8 refused, 1 duplicate), each with its candidate copy beside it — 214 `rebuild` rows and 214 `extract` rows |
| characters with a voice claim | 3 | **8** |
| the roster the coverage question is asked against | 13 | 10 |
| coverage finding | **HIGH — 8 uncovered**, each named with the extraction claims that prove the loss (三色院菫子 30, 如月雨露 40, 俺 55, 秋野桜 28, 日向葵 24, 大賀太陽 16, 女 4, 下級生の女子生徒 1); 2 more at MEDIUM | **no HIGH finding at all**; 2 at MEDIUM (山田, ジョージョエン・スカイウォーカー) |
| longest line | 54,341 characters | 486 characters |
| file | 106 lines / 336,428 bytes | 227 lines / 94,841 bytes |

**The finding, stated plainly: rebuilding produces a better reference, not a passing one.** The
destroyed reference says something about 3 of the 13 names its own record ends up carrying, and the 8
it lost are characters this volume's extraction wrote 198 claims between. 山田 and
ジョージョエン・スカイウォーカー are printed in the volume's text and the extractor said nothing about
them; 一人の女子生徒, 主人公の母 and 店員 exist in the roster **only because the destroyed reference named
them**, so a rebuild that refuses to import that file also loses them. The coverage stop stays HIGH
with no exemption — `test/test-reference-store-rebuild.js` plants it on a **rebuilt** reference too, and
since §7.4 both signals are available there, including the 1-chapter case the chapter count alone used
to soften.

**The other thing it measured:** the extraction names characters its own way, and 8 of volume 01's 10
names resolve onto the roster the glossary built by rules that cannot guess. **俺 does not** — 44
claims, the largest group in the file — and linking it to 如月雨露 is a translation decision, so it is
supplied by the operator (`--alias=俺=如月雨露 --alias-reason="…"`) and recorded through `castAlias`,
which refuses a link with no reason. Without it the roster holds 如月雨露 and 俺 as two characters.
Both doors that file extraction names now use one resolver (`utils/reference-store/name-resolution.js`),
which is what §7.3's first signal depends on.

### 7.3 The coverage guard, recalibrated: what a gap is measured against

The stop slice 6 installed — *the character-voice reference covers fewer characters than the roster,
and the volume's own text says they are there* — is the check that turns volume 01's failure into a
refusal. It stayed HIGH in every scenario that planted that failure, and it stays the only coverage
finding that blocks a copy-forward. What changed is the other half: the same finding also fired on a
self-declared throwaway (『山田さん、モブキャラ』) and on a fictional film actor Himawari invents, and
a stop that fires on those is a stop people learn to argue with.

**Raw name counts were measured and rejected.** Volume 01, occurrences / distinct chapters / whether
the extraction has voice claims for them:

| name | occurrences | chapters | claims |
|---|---|---|---|
| 俺 | 858 | 10 | yes |
| ジョージョエン・スカイウォーカー | 6 | 2 | **no** |
| 三色院菫子 | **3** | 2 | **yes, 30** |
| 店員 | 3 | 3 | no |
| 山田 | 2 | 1 | no |
| 如月雨露, 日向葵, 秋野桜, 大賀太陽 | **0** | 0 | yes |

A threshold on occurrences ranks a film actor above a main character, and the last row is the other
half of the same trap: four characters with real voice claims are printed **zero** times as bare
kanji. Any rule of the form "fewer than N mentions ⇒ not important" is wrong in both directions here.

**What the rule uses instead — two independent readings of the same book.** A character the reference
says nothing about, who IS in this volume's text, is a **loss** (HIGH, blocks the copy-forward) when
either holds:

1. **this volume's extraction filed a claim about them and the reference took none.** The per-chapter
   extraction and the reference document are two separate passes, so this is a disagreement between
   two readings rather than a document graded against itself. This is volume 01's actual failure, and
   it has no exemption.
2. **their name occurs in `COVERAGE_SIGNIFICANCE_CHAPTERS` or more distinct chapters** of the volume's
   own text, measured with the store's matching rule (verbatim, then the Han-character skeleton).

Neither, and it is a **mention** (MEDIUM, `reference-voice-mention-not-covered`): reported, every one
named, each with the signal that was missing, and it does not stop the next volume. A character the
volume's text does not contain is on neither list, unchanged. An unmeasured volume falls back to the
stricter rule — every uncovered entry at HIGH — because "nobody appears in this volume" is not a thing
a store may assume.

**How 3 was picked, and why it is not tunable.** Measured on volume 01 with the store's own matching
rule (which is not the same as a raw string search — it finds 三色院菫子 in **4** chapters where the
printed name appears in 2):

| name | chapters | lines | verdict if the reference lost them |
|---|---|---|---|
| 俺 | 10 | 789 | covered — not asked |
| 女 | 9 | 146 | covered — not asked |
| 三色院菫子 | 4 | 8 | **loss** |
| 如月雨露 | 3 | 3 | **loss** |
| ジョージョエン・スカイウォーカー | 2 | 6 | **mention** |
| 大賀太陽 | 2 | 2 | covered — not asked |
| 山田 | 1 | 2 | **mention** |
| 日向葵 | 1 | 1 | covered — not asked |
| 秋野桜 | 1 | 1 | covered — not asked |

ジョージョエン is named in 2 chapters and must be a mention ⇒ the line is above 2. 如月雨露, whom the
destroyed reference lost, is named in 3 and must be a loss ⇒ the line is at or below 3. **3 is the only
value that satisfies both**, so it is a constant in `utils/reference-store/integrity.js` with no
environment knob (AGENTS.md rule 3), pinned by `test/test-reference-store-pipeline.js`.

**What had to be built first.** `cast_presence` stored one row per character and stopped at the first
hit, so "in this volume" and "in every chapter of this volume" were the same row and the second signal
was unanswerable. Migration 4 adds `cast_presence_match` — one row per (volume, character, chapter,
line, the name that matched) with the rule that proved it — and `chapters` / `matches` on the summary,
so every existing reader of `cast_presence` keeps working. Volume 01 measures 10 cast entries into 959
match rows across its 10 chapter files.

**Where the rule still answers wrong, stated.** Two places, both named in the code:

- **Chapter count cannot see a character the book rarely names.** 日向葵 and 秋野桜 are major
  characters named in **one** chapter each. If the reference lost them, only signal 1 saves them.
  That is why signal 1 is the primary one and why every MEDIUM is printed by name with the signal that
  was missing — the report's *Characters the reference does not cover* table is the price of softening
  the guard, not a decoration.
- **A claim with no citation is invisible to both signals.** Signal 1 counts claims the store
  accepted, and a claim whose quotes are on no line of the volume's text is refused at the door — so a
  character whose every extraction claim failed the citation rule has no claim to count and no signal
  but the chapter count. That is not a hole in the coverage rule; it is the evidence rule answering
  first. Every such claim is named per character in the report's *Rows the store refused to record*
  section, which is where a human is supposed to see it.

**Closed since the first version of §7.3: a rebuilt record used to have no `extract` rows.** The
rebuild consumed the extraction into record content, so signal 1 could never fire about a rebuilt
reference and a rebuilt reference that lost 日向葵 (1 chapter) would have been a MEDIUM. §7.4 is the
decision that closed it.

**Measured on the real volume, after the recalibration.** Faithful import of the destroyed
`character-voice.md` plus the volume's own extraction claims, in a copy under `/tmp/opencode`: 13 cast
entries, 12 present, 10 uncovered — **8 at HIGH** (三色院菫子 carried by 30 extraction claims, 大賀太陽
by 16, 日向葵 by 24, 秋野桜 by 28, plus 俺, 女, 如月雨露, 下級生の女子生徒) and **2 at MEDIUM** (山田,
ジョージョエン・スカイウォーカー). The rebuilt reference from the same volume's extraction: **0 HIGH**,
the same 2 at MEDIUM, plus the rebuild-provenance MEDIUM. The two cases the guard exists for are
therefore separated by the rule rather than by a threshold somebody picked.

### 7.4 The rebuild files its candidates too — the hole in §7.3 closed

The first version of the rebuild filed only adopted rows, and §7.3 named the consequence as a
limitation: on a rebuilt record signal 1 could never fire. The question put to the account owner was
whether to file the extraction claims as **candidates** beside the adopted rows, with the objection
that `unadoptedVoiceClaims` would then permanently answer "nothing". The decision was to close it.

**What was built.** For every claim the rebuild evaluates and can cite, it files two rows: the adopted
one (`source_stage = "rebuild"`, what the document renders) and the candidate one
(`source_stage = "extract"`, what the extractor found). The candidate goes through a **second handle on
the same file, opened with the `extract` stage** — a row's kind comes from the scope its handle was
opened with and never from the caller, so the rebuild's own handle cannot file a candidate and is not
allowed to try; `rebuildVoiceFromExtraction` refuses a candidate handle scoped to any other stage
rather than quietly filing none, which is how a record would otherwise lose its second reading for a
whole series. Both doors build the row from the same shape function (`voiceCandidateRow` /
`povCandidateRow`, in `extraction-adapter.js`), because two doors writing one kind of row from two
hand-written field lists is how a record ends up holding the same claim twice under two shapes the
idempotence guard cannot recognise.

**The objection, tested rather than argued.** The owner's reasoning was right, and the test says so:

- A rebuild that adopted every claim it could cite has **nothing unadopted**, and the query returns
  empty because it compared 214 candidates against 214 adopted rows — not because there were no
  candidates to compare. `test/test-reference-store-rebuild.js` asserts both halves.
- The claims the rebuild **refused** never become candidates at either door — a claim with no citation
  is not evidence — and they are not hidden: the same test asserts the report names them, so an empty
  adoption query cannot be read as "the extraction said nothing".
- Plant the gap and the query sees it. Take 日向葵's 24 adopted rows out of the real volume-01 rebuilt
  record (through `deleteOwnFact`, the verb the rebuild itself owns) and `unadoptedVoiceClaims` returns
  24 rows for her, the coverage finding is **HIGH** — *"日向葵 — the extraction filed 24 claim(s) about
  them and the reference took none"*, 1 of 10 chapters, matched by the skeleton rule — and volume 2's
  copy-forward refuses with `reference-source-fails-integrity`. Delete the candidate rows from the same
  record and the **identical loss is a MEDIUM** and the copy runs. Same volume, same loss, same rule;
  the only difference is whether the record holds a second reading.

**What the change does not do.** It does not manufacture a disagreement where there is none. A rebuild
adopts every claim it can cite, so on a freshly rebuilt record the two sets coincide and the adoption
query is empty by construction — which is a true answer, not a broken query. The loss channel a rebuild
still has is the evidence gate, and a claim that failed it is not filed anywhere. The gap signal
becomes available rather than always-on: it fires whenever the record holds candidates the document
lacks, which is what a thinner rebuild input, a later edit, or a future adoption filter would produce.

**One disagreement the two doors still have, measured on volume 01.** The extraction door searches a
claim's last-resort candidate using the **roster key** the name resolved to; the rebuild searches using
the **extraction's own spelling**. On volume 01 that is 216 accepted / 7 refused against 215 accepted /
8 refused: the two claims in question are 如月雨露（ジョーロ）／俺's *Internal voice* and *Catchphrases*,
whose only findable "evidence" is a line containing 俺. The rebuild's stricter reading is the better
one, and aligning the doors by loosening it is not on the table. Left as it is, the effect is that a
real run files 2 candidates a later rebuild will not adopt, and the audit reports them as unadopted —
which is what that query is for.

**Cost, measured:** 214 extra rows on volume 01 (300 → 514 facts in the rehearsal record), and the
audit re-checks every one of their citations against the source text. The rehearsal still makes **zero
requests** to the scripted endpoint and still exits 2 with 0 HIGH / 2 MEDIUM.

See gotcha 99, `docs/map-helpers.md` (`integrity.js`, `presence.js`, `name-resolution.js`) and
`docs/map-preproduction.md`.

### 7.5 Publishing a rebuilt reference seals its volume — the gap that stopped volume 02 from starting

Volume 01 was rebuilt, applied and committed. Volume 02 then refused to start:

```
ok: false | rule: reference-source-fails-integrity
because: volume 1's record fails 1 integrity check(s) and was not copied.
  - reference-volume-unsealed: volume 1 is represented in this store but has not been sealed
```

The refusal was correct. A record that is still editable is a draft, and a draft is not what a later
volume builds on. What was wrong is that **nothing in the rebuild path ever made the record
publishable**: `rebuild-voice` built a record, wrote the artifact, and left the volume unsealed forever.

**Publishing and sealing are now one act.** `publishRebuiltVolume` is the only thing that seals a rebuilt
record and the only thing that writes the artifact into the volume's own folder. There is no `--no-seal`
and no caller can seal without publishing or publish without sealing, because the claim a seal makes —
*this is what the volume published* — is only true when the artifact is in place. A rehearsal with `--out`
writes a scratch copy somewhere else and never reaches the function, so it cannot seal: not because the
command forgot to ask, but because nothing was published.

Three things are checked rather than trusted before the seal runs:

1. the artifact is written, and an existing one is only replaced when `moveAside` says so;
2. the file **on disk** is read back and is byte-for-byte what the record renders — a record sealed
   against a file it does not match is worse than a draft;
3. the audit reports no HIGH damage, because sealing is what lets the next volume build on a record and a
   damaged record does not get to become immutable just because the rebuild finished. A damaged rebuilt
   reference is still written — the pipeline's shape for a bad volume is *published, then stopped at the
   copy-forward* — but it stays a draft, and the report says so.

**The recovery path almost did not exist.** Volume 01 already holds `character-voice.md` **and**
`character-voice.md.rejected`, so the obvious repair — run the rebuild again with `--apply --move-aside` —
hits `rejected-artifact-already-exists`, because a second rejection would destroy the evidence of the
first. That would have left the volume permanently unpublishable. The way out is not a flag: a rebuild
that renders **exactly the file already there** is not overwriting anything, so it has nothing to move
aside and creates no second `.rejected`. Measured on a throwaway copy of the real volume 01: re-running
`rebuild-voice --volume=01 --apply --move-aside --alias=俺（主人公）=如月雨露` reports the file as
unchanged, seals **514 rows**, and `copyForwardStore({fromVolume: 1, toVolume: 2})` then succeeds,
carrying 214 rebuilt rows, 214 candidate copies and 86 glossary rows into volume 2's record — all of them
arriving sealed. Before the seal the same call refuses.

**Sealing is per-volume, and per-stage would have been the half-measure.** `sealVolume` publishes every
row the volume owns, so sealing volume 1 also seals the 86 glossary rows the rebuild never touched. That
is the right grain: what volume 2 inherits is volume 1's *record*, and a half-published volume is exactly
the state gotcha 97 exists to describe. The asymmetry the account owner pointed at — accepted glossary
rows versus a rebuilt reference nobody has read — is a fact about **provenance**, and the store already
records it as one (`reference-document-rebuilt-from-extraction`, MEDIUM, on every audit of a record that
carries rebuild rows). Sealing does not claim anybody read the reference; it claims this is what the
volume published, and the record keeps those two claims apart.

**A report that counts the run instead of the record is a report nobody can act on.** A rebuild run a
second time files nothing, and its marker said *"0 claim(s) adopted, 0 character(s) with at least one
claim"* about a record holding 214 claims across 8 characters. The marker now carries both numbers and
`rebuildProvenanceCounts` prefers the record's, with the run's as the fallback for a marker written before
the distinction existed.

**And rehearsing the seal is what found a real defect in name resolution.** Re-running the rebuild over
volume 01's own output filed 48 more claims under 俺 than the original run had — same file, same rules, a
different record — because the "its primary name is a roster key" rule fired before the recorded alias,
against a roster entry the first run had itself created. `resolveExtractionName` now tries a **recorded
alias** before that inference. See gotcha 101.

See gotcha 101, gotcha 102, `docs/map-helpers.md` (`rebuild.js`, `pipeline-store.js`,
`document-prose.js`, `name-resolution.js`).

### 7.6 A volume's published glossary is a completeness rule on its record, not a stage behaviour

The account owner measured the hole on 2026-10-10:

```
volume 01: glossary.md 18,025 bytes, 101 table lines (87 data rows)   <- 86 rows in the record, 1 refused
volume 02: glossary.md 28,605 bytes, 138 table lines (124 data rows)  <- 0 rows in the record, and the stage skips
volume 03: glossary.md 38,269 bytes, 170 table lines
... every one of the 17 volumes has a published glossary.md
only volume 01 has a character-voice-new.json or a character-voice.md
```

The glossary stage finished for all 17 volumes in a run that predates the store. Its idempotence check
skips a volume whose accepted `glossary.md` is already on disk, and that check runs **before** the
stage's store block. So switching the store flags on mid-series would have left volumes 02–17 with no
glossary rows in their records at all: the roster the coverage guard asks about would be volume 1's cast
plus whatever the voice extraction happens to introduce, and every later volume inherits that hole. The
accumulated reference the whole redesign exists to provide would be missing, quietly.

**So the rule is on the record.** `ensureVolumeGlossaryInRecord` is asked inside `openVolumeRecord` —
the one door every stage that writes to a volume's record already comes through — and it fires whether
the glossary stage ran, skipped, or was never invoked. It does not depend on a stage being added to a
command line, and there is no flag to switch it off (AGENTS.md rule 3).

**Measured on the real volume 02, on a throwaway copy, with the scripted endpoint hearing nothing:**

| step | volume 1's record | volume 2's record |
|---|---|---|
| copied as it is now (already sealed by the owner's run) | 214 `extract` + 214 `rebuild` + 86 `import`, all sealed | — |
| `openVolumeRecord(volume 2)` copy-forward | unchanged | 514 facts, 10 cast, 10 chapters, 25 prose blocks, 960 name-occurrence rows — **0 glossary rows owned by volume 2** |
| the completeness rule | unchanged | **34 imported**, 86 carried, 4 refused, 14 roster entries registered (cast 10 → 17) |
| after | unchanged | 548 facts, 17 cast, 1 MEDIUM finding, 0 HIGH |

Volume 02's `glossary.md` parses to **124 rows** (131 pipe lines minus one header per section). 34 of
them are terms volume 2 introduces and its own text prints; 86 are the cumulative rows the record
already held; **4 are refused** — ミート・ウォーズ ～ビーフの覚醒～, 夏目漱石, 太宰治, 百田尚樹 — rows
no volume's record has ever held, because neither the term nor any passage their notes quote occurs in
volume 2's text. Four refusals is the honest answer; the first version of this rule reported **46**.

**Why 46 became 4, and why that is the finding rather than a polish.** `importGlossary` checked each
row's evidence *before* it checked whether the record already holds that row. The glossary each volume
publishes contains every row the earlier volumes published, so 42 of those 46 refusals were rows the
record had held since volume 1 with volume 1's evidence behind them, being asked to also appear in
**volume 2's** text. Nothing was lost and the report read as damage. The evidence rule decides what the
store may *adopt*; a row the record already owns was adopted by the volume that owns it. The two checks
are now in the other order, and a carried row keeps `owner_volume = 1` and its own citations.

**Top-up, never overwrite.** A record that already owns glossary rows of its own is reported and left
alone (`ran: false`, the planted row byte-identical, nothing else arrived) — gotcha 97's rule, tested by
planting a row. Provenance stays honest: an imported row is stamped `import` either way, because it was
read out of the published document, and `markGlossaryBackfilled` records *why* the record has them so
the audit can say "read from this volume's own `glossary.md` when its record was opened" rather than
implying the stage authored it. A volume that contributed nothing prints **0** in the report.

See gotcha 103, `docs/map-helpers.md` (`pipeline-store.js`, `glossary-adapter.js`, `document-prose.js`,
`validation.js`).

### 7.7 The chapter-by-chapter store path, run end to end offline

Volume 02 is chunked (7 segments), as every real volume of this series is. Until now the offline
pipeline loop had never reached that branch — not because a scenario was missing, but for two reasons
that each looked like something else (gotcha 104): a plain-text volume cut into one part has no fallback
path to take at all, and the scripted model brain hardcoded the consolidated report's file name, so the
per-chapter partial stayed empty and the "never wrote real output" guard correctly refused the volume.

**What the loop is now, and why it stopped being called "chunked character-voice".** With the author
route removed (§7.11) the character-voice stage has one path: it reads the volume chapter by chapter
whatever the volume's size. There is no fallback to force onto it, so `--chunked=character-voice` is
refused by the loop and `CHUNKABLE_STAGES` is `glossary, style-guide, jump-in-wiki`. The loop is now
`npm run pipeline-loop-store`: `discover → glossary → character-voice`, with the **glossary** forced
chapter-by-chapter, the fixture cut into chapter-sized parts, and `GLOSSARY_STORE_VALIDATORS` pinned on.
What is unique about it is the store being on and the fixture having several chapters per volume — which
is also what makes the voice stage read several chapters instead of one.

| character-voice stage, two fixture volumes | flags off, one chapter per volume | store on, several chapters per volume |
|---|---|---|
| model calls | 8 | 10 |
| prompt characters | 69,703 | 85,295 |
| agent turns | 0 | 0 |
| validator-family calls | 0 | 0 |

The whole loop is 93 calls with the flags off and 39 in the store loop; both second passes are zero
calls. Before the route was removed the same stage cost 22 calls whole and 26 chunked, and 6 of the
whole-mode calls were validator agents.

**The store path runs end to end here, and it seals.** The deterministic audit fires (25 and 27 citations
re-checked on the fixture's two volumes), the extraction claims are filed, the adopted rows are rendered
into both artifacts, and the record is sealed at the end of the volume. What no longer exists in the
store path at all is the per-chapter validator agent and the findings-merge agent: consolidating partial
reports into one report was the merge agent's job, and a query over the whole record never had partial
reports to combine.

**What the store path does not replace.** The per-chapter *reading* was never a validator's job, and the
store does not add one: an agent that read the reference against one chapter could notice the reference
misdescribes a character, and no query in the store asks that question. That gap is not chunked-specific
and it is not new — the whole-installment path paid for it too — and the only thing still judging it is
the acceptance grade.

**And the loop is what caught gotcha 120.** With the store on, the glossary stage seals each volume at
the end of its own work on it, so the voice stage arrives at a record that is already sealed and holds
nothing but glossary rows — and the rebuild door refused it as "a published character-voice reference"
while reporting zero such rows. Nothing else in the test suite reaches that shape, because nothing else
runs the glossary store and the voice render in the same series. That is the argument for keeping this
loop after the thing it was named for went away.

### 7.8 The roster fold: a pronoun is not a character, and where a split may be repaired

Volume 01's record holds a cast entry keyed **俺** with the heading `俺（如月雨露・第二章終盤）` and 14 of the
protagonist's claims under it. It also holds 如月雨露, with 172 claims. `cast_merges` was empty, so nothing in
the record said they are the same person.

**Volume 01's record is not touched.** It is sealed: it is the record a published translation was built on, and
`castAlias` already refuses to merge a cast entry carrying sealed facts for exactly that reason. The fold happens
when the *next* volume's record is built, by `reconcileInheritedRoster` inside `openVolumeRecord` — the same door
the glossary completeness rule is asked at, for the same reason: a stage can be skipped and an open cannot.

Measured on a copy of the real series (`/tmp/opencode/roster-merge-proof.js`, **0 model requests**):

| | before | after |
|---|---|---|
| volume 02's `俺` | its own entry, 14 claims | `merged_into = 如月雨露`, 0 claims |
| volume 02's 如月雨露 | 172 claims | 186 claims |
| `cast_merges` | 0 rows | 1 row, reason quotes the heading |
| volume 01's `series.db` | — | **byte-identical** |

**The rule is narrow in two directions, and both are load-bearing.** An entry is folded when its key is a **bare
first-person pronoun** (a closed list, `BARE_FIRST_PERSON_PRONOUNS`) *and* its bracketed label contains another
entry's **key** as a whole token. Containment alone would fold `如月雨露（ジョーロ）【俺人格】` into **ジョーロ** —
ジョーロ is a roster entry too — and the protagonist would end up filed under his own nickname, orphaning every
glossary row keyed with his name. An entry whose label names **two** roster entries is reported and never merged:
picking between candidates is a decision, and a rule that decides in silence is the bug this layer was built to
avoid. `女（図書委員）` names nothing and stays. `俺（如月雨露の友人）` names nothing either — a label that
mentions a character in prose needs `castAlias` and a reason.

**Which presence counts the merged entry inherits: the significance signal inherits; the evidence does not.**
Presence is measured per *name* — every roster entry, merged ones included — so 俺's occurrences stay attributed
to 俺. On volume 02's own text: `俺` 951 matches across 7 of 7 chapters, `如月雨露` 10 across 7. The survivor's
row does **not** inherit the pronoun's matches, because an alias that is itself a merged roster entry is not a
search name for the entry it joined; if it were, the chapter-count fallback would be satisfied by the grammar of
the narration rather than by the book pointing at a character. The coverage rule's chapter count **is** the union
over the names one person is filed under, and that is the direction that matters: before the fold the record
called the phantom a character in 7 of 7 chapters and the protagonist a barely-present mention in 2; after it
there is one person in 7 of 7, at HIGH. The fold cannot soften the guard, and the planted damage case (a character
named in 3 of 3 chapters whom the reference never mentions) is still HIGH and still blocks copy-forward — pinned
by `test-reference-store-pipeline.js`.

**What it means for volume 01's published file.** `character-voice.md` keeps its section
`### 俺（如月雨露・第二章終盤）` with its 7 bullets, and volume 01's record keeps the entry that section was
rendered from. So volume 01's document and volume 01's record still agree with each other; what they disagree
with is volume 02's record, which says there is one person. A translator reading volume 01 sees two sections for
one character and reads both — the heading itself names 如月雨露, so it reads as a voice-mode section, which is
roughly what it is. From volume 02 onward there is one section: the voice stage seeds volume 02's file from
volume 01's, and `importVoice` now resolves that heading onto 如月雨露 (measured: 0 facts under 俺, 259 under
如月雨露, the move reported in `rekeyed`). Without that resolution the 7 bullets would have been filed back under
the retired name and `renderVoice` — which does not render merged entries — would have dropped them.

**Not built, deliberately:** the fold runs when a record is *opened*, so a phantom created later in the same
volume is not folded until the next volume's record is opened. The prevention rule (the resolver's fifth rule)
stops most of them from being created at all; a seal-time pass would close the one-volume lag.

See gotcha 105.

### 7.9 The reading half as a command of its own — unbolted, and what the real book said back

**The decision (account owner, 2026-10-11).** Unbolt the reading step from the writing step and produce
volume 02 that way. Measured, same grader, same rubric: volume 01's reference **written by an agent**
scored **48/100**; the same volume's reference **assembled by code from its own extraction** scored
**81/100**. The costs behind those two numbers are the argument: extraction 760,550 prompt tokens across
10 calls; the author pass 50,062,758; the validation pass 62,541,546. The assembled route pays the
extraction and nothing else.

**Command shape: a second command, not a mode.** `extract-voice.js` sits beside `rebuild-voice.js` and the
route is the two of them in order. A mode inside the voice stage is reachable by a normal run — the
pipeline passes flags straight through to stages, and `--stages=character-voice` is something an autopilot
does on its own — and a route that produces a reference with no author agent and no acceptance loop must
not be one a run can fall into. `extract-voice.js` is required by nothing, is not in `index.js`'s step
list, and has **no environment variable in front of any of its guards**: the sealed-volume refusal, the
evidence rule, the "a chapter that yielded nothing refuses the pass" refusal, the fact that it writes no
`character-voice.md` and seals nothing. `--dry-run` previews; `--force` is the only way to pay for a
chapter twice.

**What the extractor's context changed, and how it is known.** The stage shows chapter 0 the previous
volume's reference and every later chapter **this volume's in-progress reference** — the document the
previous chapter's author pass just wrote. In this route no such document exists. Every chapter is now
shown the previous volume's published reference, held constant, plus a bounded block naming what this
volume's own earlier chapters already produced (`buildAlreadyExtractedNote`), because
`chapterSegmentNote` tells every chapter that "the cumulative reference material already covers the
chapters before it" and in a pass that never compiles that sentence is false. The seam is `runExtract`'s
fourth argument (`stateFile`, `extraNote`), so the stage's own behaviour is unchanged and the difference
is a named decision rather than a side effect of a missing file. **The context did change**, and it was
not A/B-tested: measuring it properly would mean re-reading volume 01, which is sealed. What was measured
instead is the question that matters — whether the extractor still saw enough to cover the cast. Volume
02's extraction filed claims about **13 characters** and the audit's coverage guard found **no HIGH gap**,
so the reading pass did not lose the cast. What it did lose is stated in gotcha 106.

**Idempotence and resume.** Each chapter's answer is written to `character-voice-extract-<chapter>.json`
the moment it arrives, tagged with a sha256 of the chapter text it was produced from. The consolidated
`character-voice-new.json` is written only when every chapter is in hand, through a temporary name and a
rename. A second invocation reuses every partial whose fingerprint still matches and makes **no call** for
it; a chapter whose text changed is re-read on its own; a chapter with no partial is read. On the real
volume 02 that meant five invocations where the later ones paid only for the chapters that had failed:
invocation 4 re-read 2 chapters and reused 5, invocation 5 the same. The volume's record is opened through
`openVolumeRecord` before a single chapter is read, so the previous volume's sealed record, the glossary
completeness rule and the roster fold all fire here exactly as they fire in a run; the record is closed,
never sealed — only publishing seals, and this command publishes nothing.

**The notebook it produced:** 178 claims — 154 voice, 24 POV — spread `ch1` 48, `ch2` 22, `ch3` 32, `ch4`
21, `ch5` 8, `ch5.1` 36, `ch5.2` 11. The two chapters whose answers came back cut off are the two thinnest
chapters in the notebook, which is the shape of the route's remaining quality problem.

**What the real book broke, in order of how much it mattered.**

1. **Two of seven chapters came back cut off.** `ch4` and `ch5` produced 25,659–64,493 characters of
   reasoning and then stopped before the JSON closed, yielding 6 and 1 claims at the default
   `AI_THINKING_LEVEL=xhigh`. The same two chapters re-read at `medium` yielded **21 and 8**. The harness
   was not at fault: `finish_reason=stop`, no idle deadline, no token cap.
2. **One chapter came back malformed twice.** `ch2`'s array was valid except for a comma missing between
   two properties. A whole chapter lost to one malformed claim is twenty-odd claims paid for and thrown
   away, so an unparseable array is read **claim by claim**: what parses is kept, what does not is dropped
   and named, and the answer that could not be read is kept in the partial.
3. **The old route had the same failure and said nothing.** `character-voice/chunked.js` wraps the parse in
   `catch {}` and hands the compile pass the raw text, so a chapter can vanish from the notebook with no
   log line. Volume 01's 223 claims across 10 chapters is consistent with that having happened.
4. **There is no way to re-read one chapter.** `--force` re-reads the volume. The operator's move is to
   delete that chapter's partial, which works but is not a named capability.
5. **The route produces no `pov-map.md`, and the acceptance check names that file.** `acceptanceCheck`
   always sends `{ file: povOutputFile }` and the harness throws on a missing file message, so the voice
   stage's own grader cannot run on a rebuilt volume at all (gotcha 107).

**What volume 02 cost, read out of the run logs.** 14 extraction calls / **1,141,844 prompt tokens** /
515,638 completion / **1,657,482 total** / 3,062 s of model wall clock (0.85 h). The seven chapters with
no wasted call — the answer each chapter ended up keeping: **532,050 prompt tokens / 782,106 total**; the
seven retries that were thrown away cost 609,794 prompt tokens on their own. One grading call: 21,316
prompt / 2,374 completion. Against volume 01's authored run — 166,711,658 prompt tokens, 12.7 hours, 37
calls — the route is **146× cheaper counting every call and 313× counting only the answers it kept**, and
the plan's under-10,000,000-token target is met with the retries included.

**What volume 02 published.** `character-voice.md`, 419 lines, **15 character sections**, 366 bullets,
longest line 486 characters, zero truncated bullets. It is the **accumulated** reference: 196 claims
established in volume 1 (carried from volume 01's sealed record) and 170 established in volume 2. The
record was sealed in the same act that wrote the file — 442 rows owned by volume 2, 956 facts in the
snapshot — and the next volume's copy-forward may build on it. The roster fold fired when the record
opened (`俺` → 如月雨露, 14 claims moved, one `cast_merges` row, no `### 俺` section in the published
file); the glossary completeness rule fired (34 imported, 86 carried, 4 refused); the evidence rule
refused **3 of 178** claims. The audit found **0 HIGH and 3 MEDIUM**: one coverage mention naming three
roster characters the reference says nothing about — 山田 in 2 of 7 chapters, 二の宮君 and 斗真君 in 1 each,
all below the 3-chapter line with no claim from either pass — and two provenance rows saying volumes 1 and
2 were assembled by code. One real grade: **80/100, "Pass with minor edits"**, above `PASSING_SCORE=69` and
`ACCEPTANCE_SAMPLE_FLOOR=54`, below the exceptional threshold. The grader's own words: *"Reference is
thorough and well-cited for main characters with no contradictory quirks or missed POV markers; the three
MEDIUM findings (minor characters below threshold, no human review pass) are non-blocking nits, and some
redundancy in the 三色院菫子 section slightly reduces polish."* The redundancy it names is **not** something
the deterministic report reports — no query asks whether two bullets about one character say the same thing
— so this is a defect only a model noticed, in a reference no model wrote.

**What this route still does not do.** It writes no `pov-map.md`, so the POV half of the artifact is not
produced and the stage's own acceptance loop cannot run against it. It inherits whatever the extraction
model gets wrong, with no author agent between the notebook and the published file — including volume 01's
drafting note, which is carried verbatim into volume 02's published reference (one occurrence, in the
秋野桜 section) because it is stored as a claim and no deterministic check asks whether a claim's prose is
finished writing.

See gotcha 106 and gotcha 107.

---

### 7.10 The map the record already had, the route that became the default, and the cut-off answer

**What this section records.** Three things landed together, and each one was a gate the previous
section left standing: §7.9 named the missing `pov-map.md` as unfinished work (gotcha 107), the
read-then-assemble route was a command the account owner typed rather than what a run does, and a
chapter whose answer arrived cut off was accepted.

**The POV map, rendered from the record.** The acceptance check names `pov-map.md` in its message
list and the harness throws on a named file that is absent, so the stage's own grader could not run
on an assembled volume at all. The fix that was on the table — drop the file from the grader's
messages, or let the check tolerate its absence — was refused: the rubric scores "the character voice
reference **and POV map**", and a grader handed one of the two prints a number about something it did
not look at. The claims were already in the record. Volume 02's holds **61 adopted point-of-view
rows** — 40 carried from volume 1's sealed record, 21 established in volume 2 — and `renderVoice`
drops the 23 with no character to file them under, because a character section needs a character. A
POV map is organised by **chapter**, which is the shape that does not need a person to hang a claim
on. `utils/reference-store/pov-map.js` renders them with `renderRebuiltVoice`'s filter unchanged
(adopted rows only, no folded roster keys) and renders the unattached ones labelled
`chapter-level observation` rather than inventing a name.

Measured: **61 claims over 11 chapter sections, 37,334 bytes, longest line 582 characters, 0
truncated bullets**, `series.db` byte-identical afterwards. Re-graded through the stage's own
`acceptanceCheck` with the map present: **82/100** for one call (38,214 prompt / 1,862 completion /
40,076 total), against **80** for the same artifact without the map (21,316 prompt) and volume 01's
**81** with its authored map (24,205 characters of prompt). The grader's own note: *"Comprehensive
voice coverage for all main characters with extensive textual citations and a thorough POV map; the
only findings are three throwaway characters below the 3-chapter threshold and the process note that
the reference was code-generated without human review, none of which blocks acceptance."* **82 and 81
are now comparable in a way 80 and 81 were not**: same rubric, same grader, same sampling of the
reference, and a POV map of a similar size in both.

**What changed about the artifact's meaning, and what did not get fixed.** `character-voice/carry-forward.js`
and `character-voice/amend.js` both stated that `pov-map.md` describes **only this volume**. The
rendered map is cumulative, because it renders the record and the record is cumulative. Translation
context is not the objection — `utils/translate/references.js` injects at most 2,000 characters,
chosen by which sections the chapter being translated matches — the objection is meaning, and the
honest statement is that **the two routes now produce files with the same name and different
contracts**: an author-route map describes one book, an assembled map describes the series so far.
That divergence is written into both files and is unresolved. What the rendered map also does **not**
produce is the per-chapter marker census an author agent wrote for volume 01; `povMarkersNamed` counts
the marker symbols the record's own claims quote and the file says that is what it counted.

**Publishing a map for a sealed volume is a read.** Volume 02 is sealed, so `extract-voice` and
`rebuild-voice` both refuse it. `rebuild-voice.js --render-only` opens the store with `create: false`,
renders, writes one file, closes: no claim filed, nothing sealed, the sealed state reported rather
than altered. That is a different question from "may a rebuild run against a sealed record", which is
still refused. The probe that sharpened this ran `--apply --move-aside` against a sealed record and
found the rebuild **ran anyway** — byte-identical output, zero new rows — while
`resetDocumentMirror`'s `rebuild-refuses-a-sealed-voice-record` refusal sat there counting only
`source_stage = "document"` rows. A guard whose counter misses the rows a route writes is not
covering that route; it is worth knowing that before trusting the guard.

**Read-then-assemble became what a run does.** `character-voice/assemble.js` became the voice stage's
default route, and then its only one (§7.11). At the time it was added, `--route=author` still selected
the older flow; the selector was a command line flag rather than an environment variable, and an
unrecognised value was an error rather than a fallback — the same rule the refusal of `--route=` keeps.
On this route the stage opened the volume's record whatever `VOICE_STORE_VALIDATORS` said, because the
record *is* the artifact's source.

The gate is unchanged from the two-route era — the deterministic audit, the same rubric, the same three
files handed to the grader, `pov-map.md` included. What the new route dropped is the **feedback pass**,
because there is no author to ask: `maxIterations: 1`, one grade per volume instead of five, and a
failing grade moves both artifacts to `.rejected`, leaves the record a draft (which is what the next
volume's copy-forward refuses), and throws, so the step runner's post-mortem and ticket machinery see
it like any other failed step. `test/test-task-failure.js` pins that shape end to end.

The offline loop's numbers moved, and the honest reading is that they moved for the right reason: the
whole-pipeline default loop is **93 calls** where it was 107, with the character-voice stage alone going
from 24 to 8. The store variant moved too, from 47 to 39, when it stopped running the voice stage down
the author route's chapter-by-chapter fallback (§7.7).

**A cut-off chapter is a different failure from a malformed one.** Volume 02's own partials, read
after the fact: `ch2`, `ch4` and `ch5` each already carried `cutOff: true`. The scanner had noticed
the array never closed; the pass printed the claim counts and kept going. A malformed claim is one bad
object in a readable array — keep the rest, name the one. A cut-off answer is **half an answer**: the
model stopped mid-list and whatever it was about to write is not in the file, so no downstream rule
can say which claims are missing. `character-voice/reading.js` (shared by the stage route and
`extract-voice.js`) retries one cut-off chapter once at `EXTRACTION_RETRY_THINKING_LEVEL` — a
constant, chosen by the measurement (6 and 1 claims at `xhigh`, 21 and 8 at `medium`) — the better
answer wins, both attempts are recorded in the partial with the level each ran at, and a chapter still
cut off after `MAX_ATTEMPTS_PER_CHAPTER` is kept, printed as **INCOMPLETE**, named in
`character-voice-reading.md`, appended to the validation report the grader reads, and given exit code
2. `PARTIAL_SCHEMA` 2 added the `attempts` array and `readPartial` now answers *may this be reused*
and *is it complete* separately, because resume was the quiet half of the bug: a cut-off partial whose
fingerprint matches is reused forever. `--chapter=<id>` re-reads one chapter by name.

**How much of volume 02's published reference came from the thin chapters.** Chapter 4 contributed
**21** bullets and chapter 5 **8** — **29 of the 366 bullets in the published file (7.9%), or 17.1%
of the 170 claims volume 2 itself established**. Chapter 2 was cut off too and contributed 21. Those
numbers are the re-read answers; the first answers would have contributed 6 and 1.

**What this slice did not do.** Volume 02 is sealed, so `extract-voice --chapter=ch4` is refused for
the one volume where re-reading is most wanted; getting those chapters read again means the challenge
path or an unseal decision, and neither was taken. Volume 01's authored `pov-map.md` (54,923 bytes)
was not replaced by a rendered one, and volume 01's six baseline files are byte-identical. The
author route's map is still per-volume. And the rendered map is not the marker census: an author agent
reading a chapter could notice a viewpoint break the extraction never filed, and no query in the store
asks that question — the same gap §7.3 names for the coverage guard, in a different artifact.

### 7.11 The author route removed, and what it was measured to have bought

The plan of record kept the author route behind `--route=author` while the read-then-assemble route was
being built, on the plan's own rollback rule: a stage that has not run a real volume through the new path
keeps the old one. Volumes 1 and 2 have now run through the new path, were re-graded through the stage's
own acceptance check, and are sealed on it. The old path was no longer a rollback — it was a second
implementation of the same stage, with its own prompt pairs, its own QA loop wiring, its own carry-forward
seed, its own mode decision, and its own tests. It was removed rather than left deprecated.

**What it cost, measured from the run log rather than remembered.** Volume 01's authored run
(`2026-10-09T20-32-15-343Z`): **166,370,184 tokens** across **25 agent turns** (10 compile agents, 10
validators, 1 findings-merge, 4 completed feedback agents) and **11 one-shot calls**. The four completed
feedback agents alone: **256 tool calls, 131 writes, 53,656,318 tokens — 32.3% of the run**. Three of
those four ended at their step cap without a final answer; a fifth feedback turn started and the run log
ends mid-turn.

**What it bought, measured the same way.** **Exactly one acceptance grade was ever taken** in that run —
48/100, "Requires revision", its note naming a "blocking corrupted tail (220 lines of duplicated
fragments)" — recorded in the volume's acceptance window as `results: [48]`. **There was no re-grade after
the feedback round.** The pass that cost a third of the run produced no measurable change in the one number
the stage judges its output by, and the file it produced is quarantined on disk (`character-voice.md.rejected`,
336,428 bytes), not published.

**What the render does not produce, stated without spin.** The authored `pov-map.md` had four sections the
render has no equivalent for — Markers, Narration Types, POV Shift Summary, and **Unresolved POV Questions**
— together **58 content lines (all of them bullets), 8,493 characters, 20,849 bytes: 38.0% of that file's
bytes and 35.2% of its content lines** (the file holds 165 content lines). The rendered map is *larger*
than the authored map's own chapter section (60 bullets / 19,604 characters against 92 table rows /
15,360 characters) — and the comparison is generous to the render, because the rendered map covers both
volumes while the authored one covers one — so the loss is confined to those four sections. Of them,
`Unresolved POV Questions` is the one with real value to a translator: who is speaking in an ambiguous
passage, which 僕/俺 switches not to normalise, which characters are present but unnamed, and where not to
add interior monologue. Nothing in the record holds that, because nothing in the extraction was asked to
find it. Closing that gap means asking the extraction a new question, not restoring an author agent.

**What the stage no longer does, and what that costs.** It makes no agent call, so there is no step cap to
size, no write instruction to get wrong, and no recovery turn to gate. It no longer decides a processing
mode, so it no longer prints the "this source is N tokens against an M-token allowance" line; its size
guard is the reading pass's cut-off detector, which catches the failure that line warned about instead of
predicting it. `--chunked` is accepted and announced as a no-op. And a volume gets **one grade instead of
five**: a failing grade quarantines rather than buying a revision, which is a real trade — the old route
could act on a grader's complaints, and the new one cannot.

**The guard the removal exposed** is gotcha 120: with the store on, the glossary stage seals a volume
before the voice stage renders into it, and the rebuild door refused that as overwriting a published
reference. The author route never rendered, so it never stood in front of that guard.

**What is genuinely unfinished.** The four `pov-map.md` summary sections (§7.11 above). The speaker-
attribution work that would fill them is a separate slice and was deliberately not started here.

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
| 6 | Replace the AI validators with queries + a graded sample | **Done 2026-10-10, behind `GLOSSARY_STORE_VALIDATORS` (default off) — and, for the character-voice stage, behind no flag at all** (§7.11: that stage renders its artifacts out of the record, so a switch in front of the record is a switch in front of the stage, and `VOICE_STORE_VALIDATORS` was removed). Each planted defect is caught at the right severity — `test/test-reference-store-pipeline.js`, twenty scenarios, the shape `test/test-postmortem.js` uses. The whole-document validators make no model calls: on the offline fixture loop the glossary stage goes 21 → 15 calls and 186,301 → 116,602 prompt characters, the character-voice stage 22 → 16 and 221,281 → 157,828, the whole run 107 → 95 and 1,131,401 → 998,663, and the `glossary-validator` / `voice-validator` kinds (12 calls, 149,454 characters) stop existing. On the real volume 01, measured without a model call, one acceptance grade drops from 227,782 characters to 23,473 for the character-voice reference and from 31,763 to 17,472 for the glossary. **No real volume has been run through the stage's flag-gated path yet** — which is why both flags default off (§12). What *has* now run on a real volume is the store itself: volume 02's record was opened, filled, audited, rendered and sealed by `extract-voice.js` + `rebuild-voice.js` with the flags off, because that route has no flag in front of its record door (§7.9, gotcha 106) |
| 7 | Give the pre-production agents the read and write tools, with budgets | Tested against the scripted endpoint in `test/fake-backend.js`, **including a model that asks for more than the window can hold — that grant must be refused, not honoured** |
| 8 | Two-tier injection into the translator | The card tier is never dropped. The full tier is ranked by appearance in the chapter. A volume-N translation cannot see a volume-N+1 fact. Bumped through `REFERENCE_SELECTION_VERSION` so dependent drafts invalidate deliberately (gotcha 27) |
| 9 | The repair loop as query-and-propose | A repair agent makes **no file edits** on a published artifact |

**A tenth thing got built, and it was not on the list.** `extract-voice.js` — the reading half of the voice
stage as a command of its own (§7.9) — was added because the rebuild path had no way to produce its own
input. It is not a slice: it changes no prompt, no stage and no call the pipeline makes, and it is reachable
only by typing it. **And the bounded real run this plan asked for before slice 9 is decided has now happened**
(§10.4): volume 02 read and assembled for 1.16M prompt tokens and graded 80/100 with one call. What that run
puts on the table for slice 9 is not "the loop is too expensive" — it is that the expensive part is gone and
what is left is a route with no repair pass at all, so the defects a repair pass used to catch (a claim whose
prose is half-written, two bullets saying the same thing, a chapter whose answer came back cut off) now reach
the published file untouched.

**Slices 1–5 are built, and they add a parallel implementation that no agent touches** — nothing about what a prompt
says or which calls the pipeline makes changes, so they can be merged and tested without any
behavioural risk. **Slice 6 is built too, and it does change which calls the pipeline makes** (the whole-document validators
stop running), so it shipped behind two flags that both defaulted off: the rehearsal was `GLOSSARY_STORE_VALIDATORS=1
VOICE_STORE_VALIDATORS=1 npm run pipeline-loop`, and the switch back was un-setting them (gotcha 97). **The voice half of
that switch is gone** (§7.11): the character-voice stage renders its artifacts out of the record, so its record is opened
unconditionally and only the glossary still has the flag. **Slices 7–9 change what the agents are able to do.**
Review gates accordingly: 1–5 are safe to merge on a green suite, 6 needs the cost and quality numbers checked, 7–9 need the flag.

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
  table above are real-run numbers, and slice 6's **stage** path has not been run on a real volume — though the
   store itself now has, on volume 02 through `extract-voice.js` + `rebuild-voice.js` (§10.4). They stay open.
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

### 10.2 What volume 02 will actually cost, measured against volume 01's real run

Volume 01's real character-voice run is the only real number this plan has. Read out of the run's own
`summary.log` (each call records its prompt tokens, completion tokens, time-to-first-token and
generation speed), it is:

| family | calls | prompt tokens | wall clock | why |
|---|---|---|---|---|
| validators (10 chapters + 1 merge + 1 recovery) | 12 | 62,541,546 | **7.2 h** | 5.2M prompt tokens per call, prefilled cold |
| author-compile (one per chapter) | 10 | 50,062,758 | 3.3 h | 5.0M per call |
| feedback (4 of 10 chapters) | 4 | 53,055,992 | 1.0 h | 13.3M per call, but prefilled warm |
| extraction | 10 | 760,550 | 0.5 h | 76k per call |
| acceptance | 1 | 290,812 | 0.02 h | the whole 336 KB reference plus the whole 244 KB report |
| **total** | **37** | **166,711,658** | **12.7 h** | one QA iteration, and the loop stopped there |

Two facts in that table decide what volume 02 costs.

**The validation half is the bill, and the store deletes it.** 12 calls, 62.5M tokens, 7.2 hours — 38%
of the tokens and 57% of the wall clock — bought nothing that the store's queries do not answer. Volume
02 has 7 segments, so the same family there is 8 calls (7 chapters + 1 merge) ≈ **46M tokens and ≈ 5.3
hours per iteration**. With the flags on it is **zero**, and that is true of every *further* iteration
too: a second iteration costs 46M tokens of validation with the flags off and none with them on.

**The run stopped after one iteration because it was already 12.7 hours in — and its grade was 48.**
The volume's own acceptance record says `results: [48]` against a passing score of 70, and the delivery
audit already wrote the finding: *"the rolling window [48] never met the acceptance criterion, and the
volume was published anyway (ON_QA_LIMIT=accept). No grader signed this off."* A reference that scores
48 is a reference the loop is designed to send back for feedback, so volume 02 should be budgeted for
**more than one iteration**, which is exactly the case where the flags pay most.

Revised estimate for volume 02 (7 segments, chunked, 475,351 bytes of chapter text = 1.10× volume 01):

| | flags off | flags on |
|---|---|---|
| extraction | 7 calls, 0.6M tokens | same |
| author-compile | 7 calls, 38.5M tokens, ~3.3 h | same |
| validators | 8 calls, **46M tokens, ~5.3 h** | **0** |
| acceptance | 1–3 grades, 0.3–0.9M tokens | 1–3 grades, **0.04–0.06M** tokens (the sample is 17,456 chars and the report 4,508 — measured on volume 01's rebuilt record) |
| one feedback round | 7 calls, ~102M tokens, ~1.1 h | same |
| **one iteration, no feedback** | **≈ 85M tokens, ≈ 9 h** | **≈ 39M tokens, ≈ 3.5–4 h** |
| **one iteration + one feedback round** | **≈ 187M tokens, ≈ 10 h** | **≈ 141M tokens, ≈ 4.6–5.5 h** |

The saving is **~46M tokens and ~5.3 hours per QA iteration**, and the iteration is the unit that
multiplies. The authoring half — 7 extraction calls and 7 compile calls, ~39M tokens — is not touched by
the store at all, and it is what chunked mode makes expensive: whole mode pays for one extraction and
one compile per volume, chunked mode pays per chapter. On the fixture that is 4 authoring calls becoming
8; on volume 02, 2 becoming 14.

**The cheap thing to do before volume 02 starts** is to grade volume 01's *rebuilt* reference once, with
the store's sample and report. It has never been graded — the rebuild makes no model call — and the grade
is the only part of this estimate that is a guess. The two things the grader would be shown are computable
with no model call and are measured above: 17,456 characters of artifact sample (5 of 8 sections, from a
50,903-character document) and a 4,508-character audit report whose own line reads **"revise (minor) — 2
finding(s) to correct; none of them blocks acceptance."** One grading call, roughly 20k prompt tokens, a
minute or two. If it clears 70, volume 02 is a one-iteration volume; if it lands near 48, budget the
feedback rounds.

What is still not measured: tokens and wall time on a real volume **with the flags on**. The offline loop
cannot produce them — its scripted endpoint returns fixed usage counts and answers instantly — so the
honest measures it gives remain calls, prompt characters and tool calls.

### 10.3 The grade, measured: one real call, and what it says about the budget

One acceptance grade of volume 01's rebuilt reference, through the actual grader (`character-voice/qa.js`'s
`acceptanceCheck` — same system prompt, same user template, same judging temperature and thinking level, same
`response_format`, same four message parts including `pov-map.md`), on a copy under `/tmp/opencode`. **One call.**

| | |
|---|---|
| score | **81 / 100** |
| band | "Pass with minor edits" |
| vs `PASSING_SCORE` 69 | meets |
| vs `ACCEPTANCE_SAMPLE_FLOOR` 54 | above |
| vs `ACCEPTANCE_EXCEPTIONAL_SCORE` 85 | not exceptional (so no exceptional-confirmation shortcut) |
| prompt tokens | **48,466** (sample 17,883 chars + `pov-map.md` 24,205 + audit report 4,508 + prompt 1,117) |
| completion tokens | 2,462 |

The grader's own complaints, in its words: a drafting artifact left in the コスモス section
(`(wait, this is パンジー — need to recheck)` — it is really there, line 156 of the published file);
"code-rebuilt provenance without human review"; and "two genuinely minor characters (ジョージョエン・スカイウォーカー,
山田) lacking voice entries".

**Do the two verdicts agree?** On direction, yes, and on the specific characters exactly: the deterministic
report says "revise (minor) — 2 finding(s) to correct; none of them blocks acceptance", and its two MEDIUM
findings name ジョージョエン・スカイウォーカー and 山田 — the same two the grader named independently. The grader
found one thing the audit cannot see: the drafting artifact. That is a defect in a *published* file that copy-forward
will carry into volume 02, and no query in the store asks the question that would catch it. Closing that gap is a
shape check over the artifact's bullets, not a store query, and it is not built.

**What 81 buys.** `ACCEPTANCE_CONFIRM_ON_PASSING` is on: a first grade that already passes with the window short
of `ACCEPTANCE_MIN_SAMPLES` (2) is completed by **re-grading the same artifact** — `max(2 − 1, ACCEPTANCE_CONFIRMATION_CHECKS)`
= 2 more grades — instead of running the feedback round. So a rebuilt reference in this band is accepted for three
grades (~145k tokens) and **zero feedback passes**. That is the whole economic argument for the rebuild path.

**The worst case, with today's settings (`QA_MAX_ITERATIONS=5`, `ON_QA_LIMIT=accept`), volume 02 chunked (7 segments), flags on.**
Per-call costs measured from volume 01's real chunked run (`166,711,658` prompt tokens, 37 calls, 12.7 h):

| family | calls | tokens measured on volume 01 | volume 02, flags on |
|---|---|---|---|
| extract | 10 → 7 | 760,550 (76k avg) | ≈ 0.6M |
| compile (author) | 10 → 7 | 50,062,758 (5.0M avg) | ≈ 38.5M |
| validators + merge | 12 → **0** | 62,541,546 (5.2M avg) | **0** — replaced by the store's queries |
| acceptance | 1 per iteration | 290,812 | ≈ 48k (measured above) |
| feedback | 4 recorded (5 started) | 53,055,992 (**13.3M avg, 17.7M worst**) | 7 × 13–18M ≈ **93–124M per iteration** |

- **Best case (grade ~81, confirmed, no feedback): ≈ 39M tokens, ~3.5–4 h.** 4.3× cheaper than volume 01's 166.7M.
- **One feedback round then acceptance: ≈ 132M, ~5 h.**
- **Two feedback rounds: ≈ 225M, ~9 h** — already worse than the run we are trying to beat.
- **Five iterations, every one with a feedback round: ≈ 504M tokens, ~38 h** (≈ 659M / ~50 h at the worst observed feedback cost).

So the unbounded worst case is **3–4× worse than 171,843,556 tokens / 12.7 h**, and the crossover is the **second
feedback round**: the first one is affordable, the second is where a volume 02 run stops being cheaper than the
volume 01 run. The store removed the 62.5M validation family; it did not touch the 13M-per-chapter repair pass, and
the repair pass is what an unbounded loop buys five of.

Also measured from the real log, and it changes how much weight to put on more iterations: **3 of volume 01's 4
completed feedback agents hit their step cap without a final answer**, spending their budget on `grep` calls trying
to locate their own text inside the 55k-character reference. Paying for a third and fourth round of a pass that
does not finish is spend, not quality — which is the argument for slice 9 (repair as query-and-propose) and the
argument for bounding the loop in the meantime.

### 10.4 Volume 02, actually run: the branch that was priced as "best case" and what it really cost

Volume 02 was not run through the stage. It was run through the pair `extract-voice.js` → `rebuild-voice.js
--apply` (§7.9), which is the branch §10.3 priced at "≈ 39M tokens, ~3.5–4 h". It cost **1,163,160 prompt
tokens and 1,681,172 tokens total** — 14 extraction calls plus one grading call, 0.85 h of model wall clock.

| | volume 01, authored (real) | volume 02, read-and-assemble (real) |
|---|---|---|
| model calls | 37 | **15** (14 extraction + 1 grade) |
| prompt tokens | 166,711,658 | **1,163,160** |
| total tokens | 171,843,556 | **1,681,172** |
| model wall clock | 12.7 h | **0.85 h** |
| author (compile) calls | 10 | **0** |
| validator / merge calls | 12 | **0** |
| feedback calls | 4 | **0** |
| grade | 48/100, published anyway via `ON_QA_LIMIT=accept` | **80/100, "Pass with minor edits"** |
| artifact | 8 sections, 227 lines, one 54,341-character line | 15 sections, 419 lines, longest line 486 characters |

**The estimate was wrong in the direction that matters.** §10.3's "best case" assumed the stage's own
chapter-by-chapter path with the store flags on — 7 extraction calls *and 7 compile calls*. The compile
calls are not in this route at all, so the real number is not 4.3× cheaper than volume 01, it is **143×**
on prompt tokens. The estimate also assumed one grading call; the extraction needed seven retries it did
not predict, and those retries are 609,794 prompt tokens — 52% of the extraction spend, and the single
largest thing the plan did not foresee.

**What the two grades are and are not comparing.** Volume 01's 81 was taken with its `pov-map.md` in the
grader's materials (24,205 of 48,466 prompt tokens); volume 02's 80 had to be taken without one, because
this route writes no POV map and the harness throws on a missing file message (gotcha 107). Same grader,
same rubric, same temperature, same sample rule — different amount of evidence shown. The honest reading is
"the assembled reference graded 81 and 80 in two runs, the second with one of its inputs missing", not
"quality held".

**What the run did not buy.** No `pov-map.md`, so the POV half of the artifact is missing for volume 02;
no acceptance loop, so the score is a measurement and not a gate; and no author agent between the notebook
and the published file, which is why volume 01's drafting note is now in volume 02's published reference
verbatim. The next slice's question is whether the route is finished enough to be the default, and §7.9's
list of what broke is the evidence for answering it.

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
