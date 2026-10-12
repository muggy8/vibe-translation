# Finding levels — plan of record

**Status: a plan, not a build.** Written 2026-10-12, the same day the gap it fixes was measured.

It changes one thing: what a finding **means** to the layer that reads findings. It does not add
checks — the checks already exist and already fire. It fixes the part where what they say is thrown
away.

**Decisions taken by the account owner (2026-10-12):**
- Warnings stop being warnings. A finding that matters becomes an error the layer must investigate.
- A finding carries a **level** that says what kind of fault it is and how far the damage travels,
  so the investigator knows whether it is looking for a small fix or a large one.
- **A MAJOR finding pauses the run at the volume boundary** and is investigated before the next
  volume is built on it.

---

## 1. The gap, measured

The triage keeps a list of ten finding types it calls **damage** — the ones that decide where a run
picks up (`utils/resume/menu.js`, `DAMAGE_KINDS`). The code that builds that list filters on
severity **first**:

```js
const high   = findings.filter((f) => f.severity === "HIGH");   // state.js:307
const damage = high.filter((f) => !EVIDENCE_KINDS.has(f.kind)); // state.js:311
```

Four of the ten kinds the triage calls damage are emitted at **MEDIUM**, so they can never reach the
damage list. They become a line in a report and nothing else:

| the triage calls it damage | emitted at | where | what the layer is therefore blind to |
|---|---|---|---|
| `wrong-shape` | MEDIUM | `utils/postmortem/file.js:79` | a reference file that exists, has content, and is not the document it claims to be |
| `chapter-without-draft` | MEDIUM | `utils/postmortem/volume.js:235` | **a chapter of the book that nobody translated** |
| `accepted-without-acceptance` | MEDIUM | `utils/postmortem/volume.js:153` | a volume published with no grader signing it off |
| `audit-verdict-missing` | MEDIUM | `utils/postmortem/series.js:74` | the cross-artifact sign-off printing no verdict, so nothing downstream can read it |

Nothing in the test suite checks that the two lists agree. This is the shape of failure the whole
delivery layer exists to prevent — a real defect reported in a channel nobody reads — and it has
been in the code since the triage was split.

**And the wider rule is the same one.** `utils/resume/triage.js:187` says, in as many words, what
happens to a step whose only findings are non-HIGH:

> `non-blocking gap(s) — reported, not acted on.`

### Why `--fail-on=medium` is not the answer

There is a setting that makes a MEDIUM finding fail a step. It changes only the **exit code**
(`index/assess.js:95`). The triage re-runs the assessment independently of the exit code, classifies
that step as `gaps`, and still does not act. The obvious switch does not produce the behaviour being
asked for, which is the clearest proof that the dial itself is the wrong shape.

---

## 2. Why the dial is the wrong shape

Severity today answers one question — **should the run stop?** — and it answers it with three values:

- `HIGH` → stop.
- `MEDIUM` → print.
- `LOW` → print smaller.

There is no value that means *"this is a real fault, go and look into it, and it is probably a small
fix."* That is the level the layer is missing, and it is the reason four damage kinds are invisible
rather than merely un-punished: they were never assigned a slot that meant *investigate*.

The deeper problem is that **one word is carrying two different judgements**:

| the two questions | what they decide | today |
|---|---|---|
| Does this block the next step? | whether the run continues | collapsed into severity |
| How far does the damage travel, and what has to change to fix it? | how big a fix to look for | **not recorded at all** |

Those two come apart in real cases. A wedged process blocks everything and needs one command to fix.
A reference file with the wrong shape blocks nothing right now and quietly corrupts every volume
after it. Same severity would be wrong in both directions.

---

## 3. The levels

The level is defined by **how far the damage travels**, because that is what determines whether the
fix is major or minor — and it is measurable from what the artifact is, rather than from a judgement
about how bad the text looks.

| level | what it means | blocks the next step? | what the layer does | the fix it expects |
|---|---|---|---|---|
| **STOP** | the deliverable is missing, unreadable or empty — nothing downstream can be built on it | **yes, immediately** | investigate before anything after it runs | anything; the run is already halted |
| **MAJOR** | the deliverable exists and is usable, but it is wrong in a way **every later volume inherits** — a cumulative reference, a volume's record, the plan of record | **pauses at the volume boundary**, not mid-step | investigate, then continue | **major**: a rule, a converter, a stage's code |
| **MINOR** | wrong in one file of one volume, or in the run's own records; nothing downstream inherits it | no | investigate, batched | **minor**: one file, one volume, a re-run |
| **NOTE** | a measurement, or a leftover that is doing its job | no | report only | none |

**MAJOR pausing at the volume boundary is the load-bearing choice.** A step is the smallest unit this
runner can restart, so "pause" means: finish the volume you are in, do not start the next one, get
the answer, then continue. Pausing mid-chapter would leave a half-built volume, which is the one
state every check in this layer is written to avoid.

---

## 4. The mapping, against the kinds that actually exist

Twenty-eight finding types exist today. Every one gets a level, declared in code.

**STOP** — halt now.
`missing-required` · `missing-volume-folder` · `empty-or-stub` · `bad-json` · `audit-verdict-fail` ·
`record-unreadable` · `run-lock-stale`

**MAJOR** — pause at the volume boundary and investigate.
`wrong-shape` · `chapter-without-draft` · `accepted-without-acceptance` · `audit-verdict-missing` ·
`grade-failures` (when only *some* grades were unusable) · `step-undeclared` · `record-orphan` ·
`patch-unjudged`

**MINOR** — investigate, batched, keep running.
`missing-expected` · `unexpected-file` · `grade-failures` (partial) · `record-incomplete` ·
`record-shape` · `duplicate-record-id` · `menu-without-options` · `answer-without-diagnosis` ·
`closed-without-outcome` · `claim-unsupported` · `nothing-executed` · `run-lock-stalled` ·
`run-lock-unverifiable`

**NOTE** — report only.
`quarantine-present` **when the output beside it is complete** — which is the volume-15 lesson: a
gate fired, the evidence was kept, the work is finished. When the same kind appears beside *missing*
output it is not a note, it is STOP, because the gate removed the deliverable and a re-run
reproduces the identical quarantine.

`quarantine-present` is the one kind that **already** reaches an investigation today, and that is why
it is the model for the rest rather than a new idea: the route exists, it is just open for exactly
one of twenty-eight kinds.

**The four kinds this plan exists for are the first four under MAJOR.** They move from "cannot be
seen" to "pauses the run and gets looked into", which is the whole change.

---

## 5. The investigation

It reuses the role that already exists. The diagnostics team is read-only, may open the code, the
prompts and the run transcripts, answers in a fixed shape (cause, options each with what it touches /
cost / risk / how to check, a recommendation, questions back, an owner note), and its options go
through the banned-option filter on the way in. Nothing new is needed on the answering side.

What is new is **who is allowed to summon it** and **how often**.

**Bounded, because this is the first part of the layer that is not free.** The current assessment
costs nothing by design; an investigation is a real model turn. The bound:

- **one investigation per (finding kind, step) per run**, not per occurrence. A finding that appears
  in 17 volumes is one investigation, not seventeen. This is the shape `DETECTIVE_MAX_GROUPS` /
  `DETECTIVE_MAX_STEPS` / `DETECTIVE_TOKEN_BUDGET` already use for the attribution pass.
- the existing turn bounds stay: the repetition detector, the loose turn clock, the read-only tool
  gate, and the rule that a diagnosis must show the files it actually opened.
- an investigation already answered in this run is not paid for twice — the answer is on the ticket,
  and the ticket is the record.

**The investigator judges the size of the fix. It does not judge the level.** It already answers with
what each option touches, its cost and its risk, which is exactly "minor change or major change".
The level is decided before it is called, by code, from the table in §4.

---

## 6. The guard, and why the level cannot be a model's judgement

A level that the role in trouble can assign is a level that gets lowered. This layer's history is
one long argument for that sentence: volume 15's gate quarantined a glossary that had *grown*, and
the cheapest available answer was to switch the gate off — the same setting under which 457 terms once
vanished with no error at all.

So:

- **The level table is data, in a banned patch path.** `utils/postmortem/`, `utils/resume/` and
  `utils/tickets/` are already closed to the dev team, and the level table belongs there. The dev
  team cannot re-grade the finding it is being investigated for. This is `AGENTS.md` rule 3 with no
  environment knob on it.
- **A test pins the two lists against each other.** For every finding kind: the level it is declared
  at, the severity it is emitted at, and the route the triage gives it must agree. A new kind with no
  level, or a kind emitted at a severity its level contradicts, **fails `npm test`**. That test is
  the one that would have caught §1.
- **The level is on the finding, in the report, in the ledger.** Not derived at read time by whoever
  is reading. Otherwise the same finding has two answers depending on who asks.

**One consequence worth saying out loud:** because the level table lives in a banned patch path, this
work cannot be done by `npm run fix`. It has to be dispatched as ordinary build work. That is the
correct routing, not an inconvenience — the alternative is the investigated role editing the rules
that judge it.

---

## 7. Build order

One worker session per slice, each ending with `npm test` green and checked against the disk before
it is reported as done.

| # | slice | what it has to prove |
|---|---|---|
| 1 | The level table as data, and the test that pins emitted severity against declared level. | The four blind kinds fail the test **before** any behaviour changes — the slice is proven by a red test it makes green. No routing changes yet. |
| 2 | The triage routes on level instead of severity: `STOP` halts, `MAJOR` pauses at the volume boundary, `MINOR` batches, `NOTE` reports. | A planted `chapter-without-draft` fixture becomes a pause and an investigation, not a note. A planted `unexpected-file` does **not** stop a run. |
| 3 | The investigation bound: one per (kind, step, run), the answer filed on the ticket, a second occurrence reusing it. | A finding present in every volume of the fixture produces **one** model turn, and the offline loop's call count records the number. |
| 4 | The pause is executable: the run stops at the volume boundary, the answer is obtained, and the run continues from that volume. | The offline loop shows a MAJOR finding halting at volume *n* and resuming at volume *n* — not at *n+1*, and not mid-chapter. |
| 5 | The docs and the maps: `docs/delivery-layer.md`, `docs/environment.md` if any knob moves, and a gotcha for the four-blind-kinds finding. | The maps describe the routing that exists. |

---

## 8. The numbers this has to produce

| measure | today | after |
|---|---|---|
| kinds the triage calls damage that can actually reach its decision | **6 of 10** (`missing-required`, `missing-volume-folder`, `empty-or-stub`, `bad-json`, `audit-verdict-fail`, `step-undeclared`) | **10 of 10** |
| finding kinds with a declared level and a route | 0 — routing is by severity alone | **all 28** |
| chapters of the book that were never translated, caught by the layer | **0** — the check exists and its output is discarded | every one, at MAJOR |
| volumes published with no grader signing off, caught | **0** — same | every one, at MAJOR |
| investigations per run | 1 kind (`quarantine-present`) | bounded by (kind × step), counted in the offline loop |
| model calls added to the offline loops | 93 / 39 today | re-baselined and written into this plan |

**Slice 1 has to produce the red test first.** If it goes green immediately, the measurement in §1 is
wrong and this plan is wrong, and that is the cheapest possible way to find out.

---

## 9. Open questions

1. **How many MAJOR findings does a real 17-volume run produce?** Unknown, and it cannot be known
   until the corpus is re-extracted, because the corpus currently holds no generated output. If the
   answer is "several per volume", a pause-at-every-MAJOR run spends more time investigating than
   translating, and the bound in §5 has to tighten. **This is measured before slice 4 is trusted.**
2. **Does a MAJOR pause need a ceiling?** A STOP halts outright. A MAJOR pause that cannot get an
   answer becomes the thing this layer refuses everywhere else: a run that stops making progress. The
   per-step intervention budget is the obvious ceiling, and whether it is the right one is a decision
   for after the first measurement.
3. **Do the reference store's own findings join this scale?** `utils/reference-store/validation.js`
   produces its own HIGH/MEDIUM findings (the coverage guard, the evidence rule) and they are graded
   by the stage, not by the triage. Two severity scales in one repository is how the POV map's audit
   and the delivery audit came to disagree in the first place. Merging them is a larger change than
   this plan and is deliberately not in it.
4. **Is `unexpected-file` really MINOR?** It reports a file the pipeline does not recognise sitting in
   a volume folder, which means stale output gets audited as if it were current. That is a sentence
   about a *measurement being wrong*, not about a deliverable being wrong — which argues for NOTE.
   It is placed at MINOR here because it can hide a real artifact behind an old one. Measure it
   against the real corpus before it is pinned.

---

## 10. What this changes in the extraction plan

`utils/source/plan/01-extraction-step.md` decides that its audit **stops on HIGH and warns on
MEDIUM**. That decision was made against the routing that exists today, and today "warn" means
"discarded".

Under this plan the extraction audit's three MEDIUM checks — a character name that only ever appears
broken apart, a chapter titled with a filename, a cache missing its pronunciation-guide file — become
**investigated** rather than printed. The name-split one is MAJOR, because every later volume measures
characters against a record built from that text; the other two are MINOR.

The extraction plan's own decision stands — a converter change should not halt a run over a filename —
but it now means *MINOR rather than ignored*, which is a different promise than the one written on
2026-10-12.
