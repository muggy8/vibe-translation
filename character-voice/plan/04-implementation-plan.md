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

With both fixed, `npm run pipeline-loop-chunked` (part of `npm test`) runs `discover → glossary →
character-voice` with the character-voice stage forced chapter-by-chapter and both store flags pinned
on. What it shows:

| character-voice stage, two fixture volumes | whole, flags off | whole, flags on | chunked, flags off | chunked, flags on |
|---|---|---|---|---|
| model calls | 22 | 16 | 44 | 26 |
| prompt characters | 221,317 | 159,541 | 495,577 | 295,973 |
| validator-family calls | 6 | 0 | 18 | 0 |

**The chunked branch does run the store.** The deterministic audit fires (27 and 29 citations
re-checked on the fixture's two volumes), the extraction claims are filed, the finished reference is
mirrored, and the record is **sealed** (9 rows, then 0) — the seal lives at the task level, so both modes
reach it, and the whole-mode→chunked retry is safe because `mirrorVoiceArtifact` resets this volume's
mirror before re-importing.

**What vanishes in the chunked branch specifically:** 12 per-chapter validator agents and 6
findings-merge agents (whole mode drops 6 validator agents). The merge agent's work — consolidate the
partials, dedupe, keep the chapter tags, produce the summary and verdict sections — is fully replaced,
because consolidating a report checks nothing. What is **not** replaced is the per-chapter *reading*: an
agent that read the reference against one chapter could notice the reference misdescribes a character,
and no query in the store asks that question. That gap is not chunked-specific — whole mode pays for it
too — and the only thing still judging it is the acceptance grade.

**And the chunked branch is more expensive, which the flags do not undo.** Whole mode pays for one
extraction and one compile pass per volume; chunked mode pays for one of each **per chapter**. On the
fixture that is 4 authoring calls becoming 8; on volume 02 it is 2 becoming 14. The store removes the
validation half of the bill, not the authoring half.

See gotcha 104, `docs/map-tests.md` (`test-pipeline-loop.js`, `fake-workflow.js`, `prompt-audit.js`).

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
