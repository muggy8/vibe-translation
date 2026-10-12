# Finding levels — plan of record

**Status: a plan, not a build — except slice 7, which is built (2026-10-12).** Written 2026-10-12, the same day the gap it fixes was measured. Slices 1–6 are unbuilt; slice 7 (the extraction step declaring its own output, and the run-scope guard amended to name it) is in the tree and measured against the real corpus.

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

**MAJOR pausing at the volume boundary is the load-bearing choice** — and it is also the one thing
in this plan the current architecture **cannot do**. That has to be said here rather than discovered
in slice 4.

### 3.1 The pause does not exist yet, measured

A step runs **all of its volumes inside one process**, and the assessment runs **after the step
returns**:

- `index/main.js` spawns one gulp process per step; the step's own task walks the volumes inside it.
- Seven of the stages walk those volumes through one shared loop — `runVolumeSeries` / `walkVolumes`
  in `utils/series-run/loop.js` (`glossary`, `character-voice`, `style-guide`, `jump-in-wiki`,
  `translate`, `verify-translate`, `polish`).
- That loop takes `processVolume` per volume and `afterVolumes` **after all of them**. There is no
  hook after **one** volume.

So today a MAJOR finding at volume 3 is discovered **after volumes 4–17 have already been built on
it** — which is exactly the damage the pause exists to prevent. A plan that says "pause at the volume
boundary" without saying where the pause lives is a plan that describes an outcome, not a change.

### 3.2 Where the pause has to live

**One place, not seven.** The gate belongs in `walkVolumes`: after a volume's work completes, assess
that volume for that step, and if the result is STOP or MAJOR, stop the walk and exit with a distinct
code. Seven stages get it by inheriting it; the stages that do not use the shared loop get named as
exceptions rather than silently missing the gate.

**What it costs — measured, and cheaper than this plan assumed when it was written.** The
per-volume checks are **already happening**. `utils/postmortem/run.js` loops every volume of the step's
spec (`if (spec.perVolume) { for (const volumeEntry of volumeEntries) … assessVolume … }`), so a full
17-volume run already performs **170 volume assessments** (17 × 10 steps). What does not exist is *when*
they run: all 170 happen after the step returns. Moving them inside `walkVolumes` therefore adds no
checking work — it moves the same work earlier. Measured on the real corpus with the existing assessors:
**0.29 ms per volume** for the glossary's 7 expectations, **0.12 ms per volume** for character-voice's 5,
so 170 volume assessments cost **under 100 ms per full run**, with no model call. The framing this plan
carried when it was written — "170 assessments instead of 10" — counted calls to `runPostMortem` rather
than the per-volume work each call already performs, and it is corrected here.

> **Confirmed after slice 4, with one correction.** The gate calls `runPostMortem` once per volume, which
> is a little more than `assessVolume` alone: it re-reads the plan of record and renders the report's
> Markdown. Measured on a 17-volume fixture: **0.19–0.98 ms per volume in steady state**, 3.1 ms for the
> first call in a process, **9.3 ms for all 17**, and **0.50–1.50 ms per volume** as printed by the gate
> itself in the offline loops. "Under 100 ms per full run, no model call" holds.

**The account owner's decision (2026-10-12): every volume of every step is assessed after that volume,
not after the step.** No step is exempt, and no step is exempted because its output is not inherited.

**Refined the same day, before slice 4 was built, and this is the rule that got built.** Checking and
pausing are two different acts and only one of them is free. Assessing a volume mid-step costs nothing,
so it is done for every stage that can halt; assessing a volume mid-step for a stage that CANNOT halt
produces findings nobody records, because the after-step assessment reports the same ones a moment
later. And four steps — `extract`, `discover`, `retranslate`, `consistency-audit` — do not walk their
volumes through the shared loop at all, so "assess every step mid-step" would mean new hooks in four
stages for no benefit. What is built: **102 of the 170 volume assessments run inside the step** (the
six gated stages × 17 volumes) and **68 still run after it**. Every one of the 170 still happens.

**Which steps the gate is for — measured, not assumed.** A per-volume pause earns its keep when
**both** hold: the stage **copies the previous book's work into the next one**, so damage in book 3 is
inside book 4 before anybody notices; **and** the stage **pays per book**, so stopping at book 3 stops
fourteen payments that were built on the broken thing. Cost alone is not enough — pausing a stage whose
later books do NOT inherit the damage skips work that would have been perfectly good. Inheritance is
what makes stopping correct; cost is what makes it worth something. Measured against the tree (grep for `carryForward` / `carry-forward` /
`copyForward` / `previousVolume` / `lastGoodVolume` per stage folder, and for which stages call
`walkVolumes` / `runVolumeSeries`):

| stage | carries the previous book forward | uses the shared volume loop | model calls per book |
|---|---|---|---|
| `glossary` | yes — 12 files | yes | yes |
| `character-voice` | yes — 4 (the record is copied forward) | yes | yes |
| `style-guide` | yes — 4 | yes | yes |
| `jump-in-wiki` | yes — 1 | yes | yes |
| `translate` | yes — `previousVolumeTail` seeds each volume's continuity from the volume before it | yes | yes |
| `translate-qa`, `retranslate` | yes — 6 and 2 | yes / no | yes |
| `polish`, `consistency-audit` | no | yes / no | yes |
| **`extract`** | **no — 0 files reference any earlier volume** | **no — it has its own `extractVolumes`** | **no — 0 calls, 190 ms** |

**`extract` is exempt, and the exemption is not a loophole.** Three separate facts point the same way.
It carries nothing: each book's bundle lives in its own folder and nothing in the step reads a previous
book's output. It costs nothing, so there is no spending to stop. And running *past* a broken book is
the behaviour the step was designed for — it audits all 17 volumes before it fails, precisely so that
one run answers "what is wrong with my books?" for all of them; halting at book 3 would deliver less
information for free. Its damage is real but it travels **across steps**, not across volumes, and the
between-step assessment (`index/assess.js`: "a broken glossary is found before the translation stage
has already paid for it") is already the right place to catch it — which is what slice 7 made possible
for its own records.

So the gate belongs in `walkVolumes`, which `extract`, `retranslate`, `consistency-audit` and
`discover` do not even call. Naming them as exceptions is not a gap in the gate; for `extract` it is
the correct design.

Reading the table with both tests applied: `glossary`, `character-voice`, `style-guide`,
`jump-in-wiki`, `translate` and `translate-qa` are the gate's customers — they inherit and they pay.
`polish` pays but inherits nothing, so a pause there would skip work that was going to be fine, and it
is out.

**What "continue" means.** The runner restarts a **step**, not a volume, and `--volume` already
exists. So resuming means: the step exits at volume *n*, the answer is obtained, and the step is
re-run for volume *n* onward. The idempotent skip-checks are what make that cheap — a volume already
accepted is not paid for twice. Pausing mid-chapter is not on the table: it leaves a half-built
volume, which is the one state every check in this layer is written to avoid.

---

## 4. The mapping, against the kinds that actually exist

Twenty-eight finding types exist today. Every one gets a level, declared in code.

> **Corrected before slice 1 was scoped: it is 67, not 28.** See the measurement below. The list that
> follows is kept as written, because the four kinds this plan exists for are in it and their reasoning
> is unchanged — but nobody should build the table from this paragraph.

**And a correction made on 2026-10-12 while slice 4 of the extraction plan was being built:** the
twenty-eight names below are the delivery layer's own. **The extraction audit's kinds are not among them**
— `source-not-archive`, `no-usable-chapter`, `chapter-extracted-empty`, `guide-split-in-text` (added the
same day, HIGH), `title-is-filename`, `ruby-harvest-missing` — so the level table this plan has to write
covers **34**, not 28, and the test that pins "every emitted kind has a declared level" (§6) fails on the
six extraction kinds until the table includes them. That is not a defect in the extraction audit: its kinds
are declared in `utils/source/audit/rules.js` `EXTRACTION_AUDIT_KINDS` with the severity each one is emitted
at, which is the shape this plan wants for every kind. It is a gap in this plan's list, and it is said here
rather than discovered later by whoever builds slice 1.

**And a second, much larger correction, measured on 2026-10-12 while slice 1 was being scoped.** The
list below is not 28 kinds and the total is not 34. Scanning every `.js` in the repository for a call to
the finding constructor (`finding(severity, kind, …)` in `utils/postmortem/rules.js:73`) finds **65
distinct kinds**, and `missing-required` / `missing-expected` are built separately in
`utils/postmortem/file.js:35` where the severity comes from the expectation's own level — so the
inventory the level table has to cover is **67**, not 34. **Thirty-three of them are not named anywhere
in this plan.** They fall into three families the list simply never looked at:

| family | count | examples, with the severity they are emitted at |
|---|---|---|
| the reference store's own audit | 29 | `reference-character-lost-in-copy` (HIGH), `reference-volume-unsealed` (HIGH), `reference-copy-row-count-mismatch` (HIGH), `reference-voice-covers-fewer-characters` (HIGH), `reference-evidence-does-not-verify` (HIGH), `reference-claim-filed-without-a-roster-entry` (MEDIUM), `reference-voice-mention-not-covered` (MEDIUM), `reference-record-reattached-to-its-source` (MEDIUM) |
| the manager and the loop | 3 | `loop-crashed` (HIGH), `manager-refused` (HIGH), `manager-corrected` (LOW) |
| the extraction audit, already named above | 6 | `source-not-archive`, `no-usable-chapter`, `chapter-extracted-empty`, `guide-split-in-text` (all HIGH), `title-is-filename`, `ruby-harvest-missing` (both MEDIUM) |

Two things follow, and they change what slice 1 has to do. First, **the table is 67 rows, not 34**, and
the test that pins "every emitted kind has a declared level" is the only thing that will keep it honest
as kinds are added — a hand-written list of 28 was already wrong twice. Second, the reference-store
family is where the *cumulative* damage lives: `reference-character-lost-in-copy` and
`reference-volume-unsealed` are exactly "wrong in a way every later volume inherits", which is the
definition of MAJOR, and they are not in `DAMAGE_KINDS` at all. The four kinds this plan was written for
are the visible symptom; the store's own audit is the larger half of the same disease, and it was
invisible because nobody counted.

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

- **The level table is data, in a banned patch path.** `utils/resume/` and `utils/tickets/` are already
  closed to the dev team. **`utils/postmortem/` was not** — measured when slice 1 was built,
  `BANNED_PATCH_PATHS` (`utils/patches/rules.js:100`) covered tickets / resume / delivery-verify / ledger /
  runlock / patches / reference-store and did not name `postmortem`, so the sentence this plan originally
  wrote here was false, and the table it asked for would have landed in a path the investigated role can
  edit. Closed by adding `postmortem` to that pattern and `test/test-finding-levels.js` to the
  constraint-tests pattern beside it, because a guard whose proof is editable by the role it judges is
  decoration (gotcha 67, and gotcha 129 for the gap itself). The dev team cannot re-grade the finding it is
  being investigated for. This is `AGENTS.md` rule 3 with no environment knob on it.
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
| 1 | The level table as data, and the test that pins emitted severity against declared level. | **BUILT 2026-10-12.** `utils/postmortem/levels.js` (447 lines) declares a level and a one-line `why` for all **67** kinds — STOP 18 · MAJOR 29 · MINOR 15 · NOTE 5 — and `finding()` in `utils/postmortem/rules.js` stamps `level` onto every finding beside `severity`; an unknown kind gets MINOR **and** says `level undeclared for kind "…"` in its own message. `test/test-finding-levels.js` (342 lines, **461 checks**) enumerates the kinds from the source text and fails on any undeclared one, on a STOP kind not emitted at HIGH, on the count moving off 67, on the damage kinds the triage cannot see moving off exactly **4** (`wrong-shape`,
`chapter-without-draft`, `accepted-without-acceptance`, `audit-verdict-missing` — the four from §1), and
on the table or the test leaving the banned-path list. **The red test came first, as required:** run against an empty table it failed by naming 67 kinds, 29 of them from the reference store's audit. `npm test` exits 0 with every baseline unmoved — 93 requests / 18 kinds and 39 / 6, both second passes 0 calls, prompt audit 22 checks / 0 findings in both loops. **Nothing about what a run does changed:** `DAMAGE_KINDS`, `EVIDENCE_KINDS`, `utils/resume/`, `index/assess.js` and `--fail-on` are byte-identical. |
| 2 | The triage routes on level instead of severity: `STOP` halts, `MAJOR` pauses, `MINOR` batches, `NOTE` reports. | A planted `chapter-without-draft` fixture becomes a pause and an investigation, not a note. A planted `unexpected-file` does **not** stop a run. |
| 3 | The investigation bound: one per (kind, step, run), the answer filed on the ticket, a second occurrence reusing it. | A finding present in every volume of the fixture produces **one** model turn, and the offline loop's call count records the number. |
| 4 | **The per-volume gate in the shared volume loop** (§3.2) — the thing that makes a pause possible at all. | **BUILT 2026-10-12.** The policy is data: `utils/postmortem/halt.js` (392 lines) declares `HALT_LEVELS` (`STOP`, `MAJOR`), `HALT_STAGES` (glossary, character-voice, style-guide, jump-in-wiki, translate, verify-translate — each with the reason it inherits), `LOOP_STAGES_NOT_GATED` (`polish`: pays, inherits nothing), `NO_VOLUME_LOOP_STAGES` (`extract`, `discover`, `retranslate`, `translate-qa`, `consistency-audit`, `translation-report`, each named with why it never reaches the gate), `haltsForStep`, `haltTriggerFor` (reads the level from `./levels.js`, never a severity), and `VolumeHaltError` — named and **structural**, so `ON_VOLUME_ERROR=skip` cannot walk past it. `walkVolumes` assesses each volume that finishes (`runPostMortem` with `volumeArg`, assess-only, nothing mid-chapter, nothing in `--dry-run`) and ends the walk on a trigger; the halt is recorded in `<run records>/last-volume-halt.json` and `applyVolumeHalt` folds it into the after-step report, so "stopped after book 3 on purpose" and "broke on books 4–17" print differently (`report.halt.suppressedMissing` counts what the halt explains away). The loop clears its own step's record before it walks; `index/run-step.js` clears it too, beside the structural marker it already deletes, because a step that dies BEFORE its walk never reaches the loop's line and the previous run's halt would then silence this run's genuinely missing books. Measured: **0.50–1.50 ms per volume** in the offline loops and **0.19–0.98 ms steady state** on a 17-volume fixture (first call in a process: 3.1 ms), **0 model calls**, ~9 ms for a 17-volume step. `test/test-volume-halt-gate.js` (751 lines, **122 checks**) is the behavioural half, and **the red test came first**: before the gate existed it failed with `AssertionError: a MAJOR finding in volume 1 must stop the walk (it used to walk straight into volume 2)`, and a probe confirmed the premise (`processed: [ 'Book(01)', 'Book(02)' ]`, no error thrown). **What the gate found on its first run is the slice's most important result:** it halted the offline loop's own `translate` stage at volume 1 on a `wrong-shape` MAJOR that was a **false positive** — `translation.md` was declared `shape: "document"` while the merge prints no heading for a synthetic or source-language title (measured on the real corpus: 17 volumes, 133 chapters, **0 merge-printed headings**). The declaration was corrected to a new `prose` shape (`utils/postmortem/rules.js`: `hasProseShape` / `proseParagraphs` — at least two paragraphs of ordinary text with headings, tables, blockquote banners and rules stripped out), which refuses what `document` wrongly accepted — `# Title` alone, a banner alone, one line of model chatter — and accepts the book the stage publishes. `npm test` exits 0 with every baseline unmoved: 93 / 18 kinds and 39 / 6, both second passes 0 calls, prompt audit 22 checks / 0 findings in both loops, 461 level checks, 33 audit checks, 30 extraction-step checks, 21 ruby checks, 19 run-scope checks, 16 patch checks, 14 dev-team checks. |
| 5 | The pause is executable end to end: the run halts at volume *n*, the answer is obtained, the step resumes from volume *n*. | The offline loop shows a MAJOR finding halting at volume *n* and resuming at volume *n* — not *n+1* — and the resumed pass does not pay for the volumes already accepted. |
| 6 | The docs and the maps: `docs/delivery-layer.md`, `docs/environment.md` if any knob moves, and a gotcha for the four-blind-kinds finding. | The maps describe the routing that exists. |
| 7 | **The extraction step declares its own output** (§10), and the run-scope guard is amended to name that one exception instead of banning all of them. | **BUILT 2026-10-12.** `extract` declares four `required` run expectations — `extraction-{installment}.md` / `.json` per volume (the new `perInstallment` shape) plus `extraction-summary.md` / `.json` — and the post-mortem checks them after the step: measured on the real corpus, `extract post-mortem — CLEAN (0 HIGH, 0 MEDIUM, 0 LOW, 36 expectation(s) checked)` with 0 findings across 17 legitimate books. A planted missing per-book report is a HIGH `missing-required` naming that volume; a run limited to one volume expects that volume's record and not the other sixteen; the other twelve pipeline steps are still asserted to declare nothing, with `extract` named as the single exception and the reason written in the test. `test/test-extract-run-scope.js` (19 checks) is the behavioural half; gotcha 127 records the reversal. Independent of slices 2–6. |

**Slice 4 is the one this plan used to skip.** Slices 2 and 3 can be built without it — they change
what the triage *says* — but nothing before slice 4 changes what a running step *does*, and a plan
that reaches its final slice before noticing that has a hole in the middle of it, not at the end.

---

## 8. The numbers this has to produce

| measure | today | after |
|---|---|---|
| kinds the triage calls damage that can actually reach its decision | **6 of 10** (`missing-required`, `missing-volume-folder`, `empty-or-stub`, `bad-json`, `audit-verdict-fail`, `step-undeclared`) | **10 of 10** |
| finding kinds with a declared level and a route | 0 — routing is by severity alone | **all 67** (measured 2026-10-12: 65 kinds emitted through `finding(…)` plus `missing-required` / `missing-expected`, built in `utils/postmortem/file.js:35`) |
| chapters of the book that were never translated, caught by the layer | **0** — the check exists and its output is discarded | every one, at MAJOR |
| volumes published with no grader signing off, caught | **0** — same | every one, at MAJOR |
| investigations per run | 1 kind (`quarantine-present`) | bounded by (kind × step), counted in the offline loop |
| assessments a full 17-volume run makes | **10** (one per step, after it returns) | **170** (one per volume per step) — free of model calls, not free of time. **Measured after slice 4:** 102 of them (6 gated stages × 17 volumes) now run **inside** the step and 68 still run after it, at **0.50–1.50 ms per volume** in the offline loops and 0.19–0.98 ms steady state on a 17-volume fixture — ~9 ms for a 17-volume step, 0 model calls. |
| model calls added to the offline loops | 93 / 39 today | **93 / 39 — unmoved**, measured again after slice 4 (both second passes 0 calls, prompt audit 22 checks / 0 findings in both loops). The gate makes no model call, and the one thing it did change — the `translate` stage halting at volume 1 — turned out to be a false positive in a declared shape and was fixed at the declaration rather than re-baselined around. |

**Slice 1 produced the red test first, and it was red.** Run against an empty table it failed by naming
all 67 kinds, 29 of them from the reference store's audit. Two of this table's rows are therefore already
answered and two are not: **the 67 kinds now all have a declared level** (slice 1), and the offline loops'
call counts are **confirmed unmoved** by it — 93 / 18 and 39 / 6, both second passes silent. What is still
0 is the useful half: the triage still routes on severity, so the four blind kinds are still blind, pinned
at exactly 4 by a test that fails if the number rises and fails if it falls without the test being edited.

**Slice 4 also produced the red test first, and it too was red** — `AssertionError: a MAJOR finding in
volume 1 must stop the walk (it used to walk straight into volume 2)` — and it made two measurements
nobody asked for:

- **A declared shape that was wrong on every legitimate book, and cost nothing until the gate acted on
  it.** `translation.md` was declared `shape: "document"`. The merge prints no heading for a chapter
  whose title is a file name, a pipeline label, or a title still in the source language, and the
  translate prompt asks for the translation only. Measured against the real corpus: **17 volumes, 133
  chapters, 0 headings the merge would print** — so `wrong-shape` fired on every translated volume a
  real run could produce, at MEDIUM, where `--fail-on=high` discarded it. The gate made it a halt on
  the first pass of the offline loop. Fixed at the declaration: a `prose` shape (two or more paragraphs
  of ordinary text, structure stripped out) that accepts the book and refuses `# Title` alone, a banner
  alone, or one line of model chatter. **The general form: a level table is inert until something acts
  on it, and the first thing it acts on is the check that was already lying.**
- **The gate's own cost line was measuring the wrong thing.** It timed from before the volume loop to
  after it, so it printed the stage's model calls as the gate's cost — 91–199 ms per volume in the
  offline loop's first pass. Timed per assessment it is **0.50–1.50 ms per volume** there and
  0.19–0.98 ms steady state on a 17-volume fixture, which is what §3.2 claimed. Pinned by a source
  check in `test/test-volume-halt-gate.js` so it cannot drift back.

**Two measurements slice 1 made that this plan did not ask for and now has to answer.**

- **The stray-file check cries wolf, and now that would cost something.** Assessing all 13 steps against
  the real corpus produced 18 `unexpected-file` findings, **2 distinct files, both `.gitignore`** — the file
  `utils/reference-store/quarantine.js` writes into every volume folder (gotcha 116) — and **0 genuine**.
  Declared legitimate in `utils/artifacts/rules.js` and pinned in `test/test-postmortem.js`. It was free to
  ignore while a MEDIUM was discarded; at MINOR it is an investigation somebody gets paid to run.
- **An empty corpus is not a measurement of MAJOR inflation.** The same pass over the 17 books, which hold
  extracted text and nothing else, produced 679 findings: **STOP 449, MINOR 229, MAJOR 1** — 449 of them
  `missing-required` for artifacts that do not exist yet. §9.1's question ("how many MAJOR findings does a
  real run produce?") is still unanswered, and this number does not answer it.

---

## 9. Open questions

1. **How many MAJOR findings does a real 17-volume run produce?** Unknown, and it cannot be known
   until the corpus is re-extracted, because the corpus currently holds no generated output. If the
   answer is "several per volume", a pause-at-every-MAJOR run spends more time investigating than
   translating, and the bound in §5 has to tighten. **This is measured before slice 5 is trusted.**
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
5. ~~Is a per-volume assessment for every step the right price, or only for the steps that can
   produce a MAJOR?~~ **Decided by the account owner on 2026-10-12: every book, every step.** The cost
   argument turned out to be empty — the 170 volume assessments are already performed today (§3.2), so
   the choice was only ever about *when* they run, and the answer is "after each book". Measured: under
   100 ms per full run, no model call. What is still open is the smaller half of this question: whether
   a volume's assessment should also run the checks that only make sense once the whole step is finished
   (the series-root publish, the cross-volume coverage rules), which cannot move earlier and stay where
   they are.
   **Refined the same day (see §3.2):** the *checking* stays everywhere, because it is free.
   The *pause* is scoped to the stages that carry the previous book forward and pay per book — which
   excludes `extract` on three independent grounds, one of them that it does not use the shared volume
   loop at all.

---

## 10. What this changes in the extraction plan

`utils/source/plan/01-extraction-step.md` decides that its audit **stops on HIGH and warns on
MEDIUM**. That decision was made against the routing that exists today, and today "warn" means
"discarded".

Under this plan the extraction audit's two MEDIUM checks that exist today — a chapter titled with a
filename, a cache missing its pronunciation-guide file — become **investigated** rather than printed, both
at **MINOR**. The third MEDIUM the extraction plan lists (a character name that only ever appears broken
apart) is still **deferred**: it needs a roster, and no roster exists at extraction time
(`utils/source/plan/01-extraction-step.md` §3), so it has no level to be declared at until it exists.

**And the extraction audit's fourth HIGH check, added the same day this plan was written, is a STOP** —
`guide-split-in-text`, a pronunciation guide still pasted inside the word it annotates. It belongs under
STOP with the other HIGH extraction kinds: it names text every downstream artifact is built from, and the
defect it hunts sat in all 17 volumes unnoticed once already.

The extraction plan's own decision stands — a converter change should not halt a run over a filename —
but it now means *MINOR rather than ignored*, which is a different promise than the one written on
2026-10-12.

**And the account owner's second decision (2026-10-12): the extraction step's own output is
checked, after its own step, because everything downstream is built on it.** Measured against
`utils/artifacts.js`: `extract` declares **nothing today** — 0 volume expectations, 0 series
expectations, 0 run expectations — which makes it the one step in the run whose work nothing verifies.
Closing that means declaring its reports, and declaring them runs straight into the guard
`test/test-delivery-audit.js:225`: *no pipeline step declares a run scope*. Read the guard's own reason
(`test/test-delivery-audit.js:19`, `:219`) and the ban is narrower than it looks — it was written to prove
that adding the delivery-record audit left the corpus half of the post-mortem untouched. It is a regression
guard for one change, not a permanent law, so amending it is a legitimate decision **provided the
amendment keeps what the guard actually protects**: `extract` becomes the single named exception, the
remaining twelve pipeline steps are still asserted to declare nothing, and the reason an exception is
allowed is written into the test rather than left to the commit message.

**And the scope is decided (account owner, 2026-10-12): every book's report, plus the
summary.** Not the small version. `assessRunScope` reads a flat list of file names out of
`postMortemDir()`, which expresses `extraction-summary.md` and `.json` directly but has no shape for
"one expected file per volume", so this slice has to teach the run-scope shape that — the same shape a
per-volume finding needs if it is ever to be routed by level instead of failing the whole step. The
reason given for the thorough version is the one that matters: `extract` writes 17 reports and a crash
part-way through leaves some of them written and some not, and a check that only looks at the summary
cannot tell "the step ran and found nothing" from "the step stopped after book 9".

**Slice 7 is built.** `ArtifactExpectation` gained `perInstallment: true`, which expands one run
expectation once per volume the run was asked to process (the volume list `runPostMortem` already
filters for `--volume`, so a one-volume run is not blamed for the reports it was never asked to write),
and each finding carries the volume whose record is missing. `extract` declares four `required`
expectations, and the severity was checked against the writer rather than assumed: `extractOneVolume`
writes a report pair for a volume whose archive would not open, and `extractVolumes` writes the summary
pair before it throws, so "every path it can reach" holds on every path the assessment can run on
(`--dry-run` writes nothing and `index/steps.js` never assesses a dry run). Measured on the real
corpus: `extract post-mortem — CLEAN (0 HIGH, 0 MEDIUM, 0 LOW, 36 expectation(s) checked)`, 0 findings.
`test/test-extract-run-scope.js` (19 checks) plants a missing per-book report, a missing summary, a
stub, half-written JSON and a wrong-shape document, and asserts each is named at the right severity
with the volume it belongs to. The guard moved as described above and gotcha 127 records both halves.
