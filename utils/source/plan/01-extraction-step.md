# The extraction step — plan of record

**Status: partly built.** Written 2026-10-12, the same day the extraction defect was found and fixed.
**Slices 1–2 are built.** Slice 1 is the audit as a pure function (`utils/source/audit.js` +
`utils/source/audit/`, tested by `test/test-source-audit.js`, 26 checks, part of `npm test`). Slice 2 is
the `extract` step itself (`extract.js` + `extract/`, tested by `test/test-extract-step.js`, 28 checks,
part of `npm test`): it sits in `gulpfile.js` `PIPELINE_STEPS` between `discover` and `glossary`, runs the
audit over every volume, writes the per-volume report and the series summary into the run's records, and
fails the run structurally on a HIGH finding. **Slice 3 is half built**: the records exist and have been
run over a copy of all 17 archives (133 chapters, 109 packaging groups, 2,450,415 characters, 45,429
pronunciation guides, 457 images, 0 HIGH, 0 MEDIUM, 1,840 ms, 0 model calls; the same run again: 154 ms,
all 17 VERIFIED), but the half that asks for a **step assessment in the ledger and the post-mortem** is
not built — the step's own audit findings reach the run only as its report files, its console lines and a
failed-step record when it throws, because `test/test-delivery-audit.js` pins that no pipeline step
declares a run scope (gotcha 127). Slices 4–5 are not built. It is deliberately its own plan rather than a
section of `glossary/plan/01-glossary-route.md`, because extraction is upstream of *every* stage, not one
of them.

---

## 1. Why this exists

### The failure it is named for

The converter used to treat a pronunciation guide like any other wrapper: tags removed,
everything inside kept in order. So the book's word and its own reading aid became one string —
`上機嫌` extracted as `上じよう機き嫌げん`, `蒲田` as `蒲かま田た`.

That defect sat in the extracted text of all 17 volumes. It put 193 broken entries into the
published glossaries, it broke character names apart so the "is this character in this volume"
rule could not see them, and it was discovered only because a name rule tripped on one girl in
volume 2. **Nothing in the pipeline was in charge of whether the extracted text was correct.**

### The ownership gap, measured

`resolveSourceBundle` is called from **eleven places**: the nine pipeline stages that read the
book (glossary, character-voice, style-guide, jump-in-wiki, translate, translate-qa,
verify-translate, polish, retranslate), the manual reading command (`extract-voice.js`), and a
progress helper (`utils/translate/progress.js`). Each one either re-extracts or accepts the cached
files. None of them checks what it gets, and none of them reports what it found. Extraction is the
only input every artifact shares, and it is the only one with no step, no report, no audit and no
record that it ran.

**And `discover` does not use it at all.** The intake measures the books through its own call to
the converter (`intake/integrity.js`), not through the bundle layer. So the step that decides *which
files are volumes and how big they are* reads the book by a different door than the nine stages that
later read it. That is the shape of gotcha 119 — a volume believed to be 2,394 tokens when it is
102,892 — and it is why §7 asks whether intake is inside this plan or outside it.

### Why it is the cheapest step to add

There is no model in it. It can be re-run for free, audited by code, and re-audited as often as
anybody likes. It is the one place in the pipeline where "run it and audit the result" costs
nothing.

---

## 2. What the step is

A new pipeline step, **`extract`**, sitting between `discover` and `glossary`:

```
discover → extract → glossary → character-voice → style-guide → jump-in-wiki
         → consistency-audit → translate → translate-qa → polish
```

It sits after `discover` because the extractor needs the plan of record to know which file is
which volume. It sits before everything else because everything else is downstream of its
output.

**It owns extraction.** The eleven callers stay exactly as they are — they become cache hits on
work that has already been done and already been checked. The step does not replace them; it
makes them safe to trust.

**It verifies rather than redoes.** On a warm cache the step reads each volume's bundle metadata,
confirms it matches the current archive and the current converter version, runs the audit, and
prints the result. It re-extracts only when something actually changed. A step that re-extracts
17 books on every run is a step people skip.

**It is runnable on its own**, the way the other steps are: `npx gulp extract`, and through the
step runner as `--stages=extract`.

---

## 3. The audit

Every check below is answered by code, without asking the model anything. Each one maps to a
failure this repository has actually had, or to the fix it has just made.

| severity | check | why it is on the list |
|---|---|---|
| **HIGH** | the volume's source is not the book archive | gotcha 119: a folder named `(01)` beside an archive named `(1).epub` made every stage believe a 102,892-token book was 2,394 tokens and "single-segment" |
| **HIGH** | a volume with no usable chapter, or every chapter empty | nothing downstream can work, and today it fails confusingly several stages later |
| **HIGH** | a chapter that extracted to nothing, beyond the pages the book itself declares as packaging | a silently missing chapter is the worst kind of missing text: it looks like a short chapter |
| **HIGH** | a guide-split string still present in extracted text | the regression tripwire for the 2026-10-12 fix. This should be zero forever, and it is the check that keeps it zero |
| MEDIUM | a character-name candidate that only ever appears in guide-split form | the 蒲田 class, caught at the source instead of surfacing inside a name-matching rule |
| MEDIUM | a chapter title that is only the file's name | a title that must not be printed as a heading |
| MEDIUM | a bundle whose pronunciation-guide harvest file is missing | a cache that certifies a hole |
| info | per volume: chapters, characters, guide annotations set aside, images, packaging excluded | the line a human reads to decide whether this looks like a real book |

### Which checks are actually computable here

Measured while preparing slice 1, and it changed the list. Two of the seven cannot be answered by
the extraction layer at all, and pretending otherwise would hand a worker a check it cannot write.

**Computable from what the extraction layer already produces** — these are the audit:

| severity | check | what answers it |
|---|---|---|
| **HIGH** | the volume's source is not the book archive | the plan of record's `sourceFile` against what the bundle actually opened |
| **HIGH** | a volume with no usable chapter, or every chapter empty | the bundle's segment list |
| **HIGH** | a chapter that extracted to nothing, beyond the pages the book declares as packaging | a segment with no body that is **not** marked packaging |
| MEDIUM | a chapter title that is only the file's name | the segment titles against the archive's own name |
| MEDIUM | a bundle whose pronunciation-guide harvest file is missing | does the file exist beside the bundle |
| info | chapters, characters, guides set aside, images, packaging excluded | the counts the extraction already writes |

**What building slice 1 found about the middle one.** "A segment with no body that is not marked
packaging" has a gap in it: **the bundle records packaging as its own list, never as a flag on a
segment.** Under the normal path that is fine — a packaging page never becomes a segment, so the audit
never sees one. Under the two fallbacks in `extract.js` (the contents list names none of the book's
pages, or names only packaging) every page stands alone as a chapter and `packaging` is cleared, so a
cover plate really does arrive as a segment with no body, and the only evidence left that it is a cover
plate is the title the book's own navigation gave it. The audit therefore exempts a segment whose title
matches `PACKAGING_TITLE_RE` or appears in the bundle's packaging list — the extraction's own vocabulary,
not a second list. **If slice 2 wants that exemption to be airtight, the extraction has to persist a
per-segment packaging mark**, which is a bundle-schema decision (it re-extracts all 17 volumes again) and
so belongs to the account owner, not to a slice.

**What slice 1 measured, and it is the first number this layer has ever had.** Not through the step
(that is slice 2) — through a throwaway script that copied the 17 archives into `/tmp/opencode/audit-real/`
and ran `resolveSourceBundle` plus the audit there, leaving the corpus untouched. Across all 17 volumes:
**133 chapters, 109 packaging groups, 0 chapters that extracted to nothing, 45,429 pronunciation guides
harvested, and 0 findings — 0 HIGH and 0 MEDIUM.** 133 chapters is the same figure gotcha 52 records for
the series, which is the cross-check that the measurement went through the real door. **The audit fires
zero times on legitimate material**, and the contents-list fallback (the only path where the packaging
exemption is load-bearing) fired **0 times out of 17**, so the exemption's narrowness costs nothing on
this series today. That was a measurement of the audit, not of the step; the step now produces the same
numbers through itself — per-volume report, series summary and JSON sidecar included — over a copy of the
same 17 archives, with the same totals and the same 0 findings (§6, slice 3).

**Deferred, with the reason said plainly:**

1. **A guide-split string still present in extracted text (HIGH).** The obvious way to check it is to
   rebuild the old broken string from the harvest and look for it. **The harvest cannot do that as it
   is shaped today.** A row is `{word, reading, count, chapters, script}` — 蒲田 / かまた — but the
   defect interleaved the reading *per annotated character* (蒲→かま, 田→た), producing 蒲かま田た.
   From a word-and-reading pair you cannot reconstruct which character carried which guide, so you
   cannot build the string you are hunting for. A pattern-match instead ("kanji followed by its own
   reading") fires on ordinary Japanese constantly, which is a guard that cries wolf until somebody
   switches it off.
   **What would make it exact:** the harvest recording the annotation's own base-and-reading sequence
   as it was annotated, not just the joined pair. That is a change to the harvest row shape — a
   schema decision with a cost (it re-extracts all 17 volumes again) — so it is a decision to make,
   not a slice to write.
2. **A character-name candidate that only ever appears in guide-split form (MEDIUM).** This one has a
   simpler problem: **at extraction time there is no roster.** "Is this a character name?" is a
   question something must first propose a name for, and nothing has. The reference store has the
   roster, the presence rule and the coverage guard, and it already catches the 蒲田 class — that is
   the rule that found the defect in the first place. This check belongs there, and moving it here
   would put a second, weaker answer to a question the store already answers.

**And the coupling this plan used to claim is not available.** `utils/reference-store/presence.js`
exports six functions, and every one of them takes a database record (`ctx.db`) — the text-level
matcher underneath, `findName(entry, chapters)`, is **not exported** and needs a cast entry that does
not exist before a roster exists. So the extraction step imports nothing from the reference store. If
a future slice needs it, the correct move is to export the matcher, not to open a record from the
extraction layer.

### What the severities do

**Decision (account owner, 2026-10-12): HIGH stops the run, MEDIUM warns.**
**Revised the same day** — see `utils/postmortem/plan/01-finding-levels.md`. "Warn" turned out to
mean "discarded": the resume triage reads only HIGH findings, so a MEDIUM finding is printed and
nothing acts on it. The decision now reads:

- A **HIGH** finding is a **STOP**. The step runner records it, the post-mortem writes it, a ticket
  opens, and the stages after it do not run — so a bad extraction costs one free step instead of a
  glossary stage that spends real tokens building on it.
- A **MEDIUM** finding is **investigated**, at one of the two middle levels. The name-split check is
  **MAJOR** — every later volume measures characters against a record built from that text — so the
  run pauses at the volume boundary until it is answered. The filename-title and missing-harvest
  checks are **MINOR**: investigated, batched, the run continues.
- **info** is not a finding. It is the measurement, and it is what makes the difference between
  "this ran" and "this ran and here is what it saw".

The original instinct stands — a converter quirk about a filename should not halt a run. What changed
is that the alternative to halting is now *look into it*, not *throw the line away*.

---

## 4. What it must not become

**No model, no grade, no acceptance agent, no QA loop.** A deterministic gate. Adding a model to
check something a checksum already proves would mean paying tokens to confirm a fact code knows
for free — and it would put a judgement call in front of the one stage where there is nothing to
judge.

Specifically excluded:
- an acceptance score for "is this a good extraction";
- an agent asked to read a chapter and say whether it looks complete;
- a repair pass that rewrites extracted text. If the extraction is wrong, the converter is wrong,
  and the fix is in the converter.

---

## 5. What it produces

1. **A per-volume extraction report** — the audit findings, the segment list with titles and
   sizes, the pages excluded as packaging and why, the image count, and the pronunciation-guide
   totals.
2. **A series summary** — one table across the volumes, so a change that affects one book is
   visible as a difference rather than as a rumour.
3. **Run records** — the step's assessment goes into the ledger and the post-mortem like any
   other step, so a repeat failure is visible to the delivery layer rather than to nobody.
4. **The first real numbers this layer has ever had.** Today nobody can say what the extraction
   layer costs or produces across the series, because it has never run as a step with a report.

---

## 6. Build order

One worker session per slice, each ending with `npm test` green and checked against the disk.

| # | slice | what it has to prove |
|---|---|---|
| 1 ✅ | The audit as a pure function over a bundle: the five computable checks in §3, against fixtures. | **Built.** Each HIGH check fires on a planted fixture and stays silent on a clean one; no stage runs, no model is called, nothing from `utils/reference-store/` is imported. What building it settled: the empty-chapter exemption has to be the **book's own declaration** (`PACKAGING_TITLE_RE` plus the bundle's packaging list), because under the contents-list fallbacks a cover plate becomes a segment and a check without the exemption re-invents gotcha 52's phantom holes; and a plain-text volume with no archive anywhere must stay silent, because `.md` books are a supported shape. |
| 2 ✅ | The step itself: `extract` in the pipeline order, running the audit over every volume, writing the per-volume report and the series summary. | **Built.** `--stages=extract` runs alone and `npx gulp extract` runs it; a warm cache re-verifies rather than re-extracts and says which it did (VERIFIED / RE-EXTRACTED / EXTRACTED / READ, decided from `bundle.cacheHit` plus whether a `<base>-bundle.meta.json` was in the folder before the call); a planted HIGH finding stops the run with a **structural** error, so `ON_TASK_ERROR=continue` cannot walk past it and `glossary` is never started; a planted MEDIUM is printed, recorded and counted, and the run continues; 0 model calls measured at the wire against the stub endpoint. What building it settled: **the step declares nothing in `utils/artifacts.js`** — `test/test-delivery-audit.js` pins that no pipeline step declares a run scope, so the reports are guaranteed by `assertWrote` inside `extract/reports.js` instead of by a post-mortem check (gotcha 127) — and a plain-text volume gets its own state word, because `cacheHit: false` there means "no cache was consulted", not "the book was extracted again". |
| 3 ◐ | The numbers, through the step: run `extract` over all 17 volumes and write the per-volume report and the series summary. | **Half built.** The records exist and have been produced through the step over a **copy** of all 17 archives: 133 chapters, 109 packaging groups, 2,450,415 characters, 45,429 pronunciation guides, 457 images, **0 HIGH and 0 MEDIUM**, 1,840 ms, 0 model calls; the second run is 154 ms and prints VERIFIED for all 17, and touching one archive makes that one print RE-EXTRACTED while the other sixteen stay VERIFIED. What is **not** built is the other half of this row — a step assessment the ledger and the post-mortem can see. The step's audit findings reach the run as its own report files and console lines, and as a failed-step record when it throws; nothing in `utils/postmortem/` knows the extraction summary exists, because of the run-scope invariant above. Closing that is a decision about the invariant (`utils/postmortem/plan/01-finding-levels.md`), not a step to write. |
| 4 | The deferred tripwire, **only if** the harvest row shape is changed to record each annotation's own base-and-reading sequence (§3). | A fixture carrying a guide-split string produces HIGH **exactly** — no pattern matching, no false positives. If the shape change is refused, this slice is not built and the deferral stands. |
| 5 | The docs and the maps: `docs/map-core.md`, the step list, and a gotcha if the build teaches one. | The maps describe the step that exists, not the one that was planned. (Slice 1 already added `utils/source/audit/` and `test/test-source-audit.js` to `docs/map-helpers.md` and `docs/map-tests.md`; the STEP list still belongs here.) |

**Slice 1 is the cheapest thing in this plan and it is done, and it already answered the counting
question.** Slice 2 is the one that makes the answer belong to the run rather than to a script somebody
ran by hand, and it is built: a report per volume, a series table, and a step that fails the run on what
it finds. What it did **not** buy is the last third of that sentence — an assessment the delivery layer can
see — because of the run-scope invariant (gotcha 127), and that is now the open question it belongs to.

---

## 7. Open questions

1. **Is `discover` inside this plan or outside it?** The intake measures the books through its own
   call to the converter (`intake/integrity.js:209`), not through the bundle layer, so the step that
   decides what is a volume and how big it is reads the book by a different door than the nine
   stages that read it afterwards. If extraction is audited but intake is not, the two can still
   disagree about what a book is — which is exactly gotcha 119. **The recommendation is to bring
   intake onto the same door**, so there is one measurement of a book in this repository rather than
   two that can drift apart; that is a bigger change than the step itself, which is why it is a
   question and not a slice.
2. **How loud should a re-extraction be?** A converter change invalidates every cached bundle.
   That should print what it removed, in numbers, and land in the run's records — otherwise the
   most consequential change in the pipeline is a log line nobody reads.
3. **Where do the pronunciation guides go from here?** They are harvested and readable, and
   nothing consumes them. The extraction step is the natural place to at least *report* the
   suspicious ones — the words the author guided with a foreign reading — even if deciding what
   to do with them belongs to the glossary.
4. **Is "empty chapter" HIGH or MEDIUM?** A genuinely empty chapter is almost certainly a
   converter failure, but a very short interlude is real text. The line has to be measured
   against the 17 archives before it is pinned, not guessed.

---

## 8. What this changes in the glossary plan

`glossary/plan/01-glossary-route.md` assumes clean extracted text underneath it and lists
"re-measure the term matcher and the evidence matcher against clean text" as an open question.
That question belongs here, not there: it is an extraction question, and once `extract` is a
step with a report, the answer is a command rather than a script somebody writes by hand.

The glossary rebuild therefore depends on this plan landing first, or at minimum on the
extraction audit having been run over all 17 volumes and produced its numbers.
