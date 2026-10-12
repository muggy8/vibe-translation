# The extraction step — plan of record

**Status: a plan, not a build.** Written 2026-10-12, the same day the extraction defect was
found and fixed. It is deliberately its own plan rather than a section of
`glossary/plan/01-glossary-route.md`, because extraction is upstream of *every* stage, not one
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

### What the severities do

**Decision (account owner, 2026-10-12): HIGH stops the run, MEDIUM warns.**

- A **HIGH** finding fails the step. The step runner records it, the post-mortem writes it, a
  ticket opens, and the stages after it do not run — so a bad extraction costs one free step
  instead of a glossary stage that spends real tokens building on it.
- A **MEDIUM** finding is recorded, printed in the step's report, and the run continues.
- **info** is not a finding. It is the measurement, and it is what makes the difference between
  "this ran" and "this ran and here is what it saw".

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
| 1 | The audit as a pure function over a bundle: every check in §3, against fixtures. | Each HIGH check fires on a planted fixture and stays silent on a clean one. No stage runs, no model is called. |
| 2 | The step itself: `extract` in the pipeline order, running the audit over every volume, writing the per-volume report and the series summary. | `--stages=extract` runs alone; a warm cache re-verifies rather than re-extracts and says so; a planted HIGH finding stops the run before `glossary` is reached. |
| 3 | The regression tripwire made real: the guide-split check, the name-split check, and the missing-harvest check. | A fixture carrying a guide-split string produces HIGH, and the real 17 archives produce zero. |
| 4 | The docs and the maps: `docs/map-core.md`, the step list, and a gotcha if the build teaches one. | The maps describe the step that exists, not the one that was planned. |

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
