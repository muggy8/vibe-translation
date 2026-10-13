# The translation route — plan of record

**Status: a plan. Nothing in it is built.** Written 2026-10-13. Every number below names the
script or the file it came from; the numbers that do not exist yet are labelled **unmeasured**,
and they are the reason slice 0 is a measurement rather than a feature.

It is the translation half of the program in `character-voice/plan/04-implementation-plan.md` and
`glossary/plan/01-glossary-route.md`: those two plans moved the pre-production artifacts into the
reference store, and this one describes what happens to the stage that **reads** them. It depends
on both, and on `utils/source/plan/01-extraction-step.md`, because the text it translates is what
that step produced.

**Why the order matters right now:** the corpus holds **no translation at all** — `find . -maxdepth
2 -name translation.md` over `/mnt/windows/weeb/oresuki` returns **0 files**, and the reset tag
`pre-extraction-fix-2026-10-12` holds `translation-plan.md` and `translation-target.json` at its
root and **no `translation.md` in any volume folder** (`git ls-tree -r --name-only` over the tag).
The stage has never run on this machine's books: every call id recorded under
`/mnt/windows/weeb/oresuki/.run/logs/` is a glossary or probe call
(`grep -rhoE "RESULT \([A-Za-z0-9_.-]+\)" .run/logs | sort -u` → 15 ids, all `glossary-*` or
`probe-*`, plus 12 `glossary-research-*` one-shot records under `.run/logs/*/one-shot/`).
Every decision in this plan is cheaper to make now than after 133 chapters exist.

All measurements: `/tmp/opencode/measure-*.js`, output captured in `/tmp/opencode/out-*.txt`,
summarised in `/tmp/opencode/translation-plan-findings.md`. **Zero real model calls were made to
write this plan.**

---

## 1. Why this is being done

The translation stage is the last stage in the pipeline that reads its references **out of files**
while every stage that writes those references now reads them **out of a record**. That split is
where the stage's two real weaknesses live, and both are measurable.

**Weakness one — the stage cannot see the whole terminology decision.**
`utils/translate/references.js:84-91` reads `glossary.md` from **the volume's own folder**. The
series-root copy that `utils/series-run/publish.js:36-58` writes is read by exactly one thing in
the codebase: the post-mortem's own run-scope check, through `seriesArtifactPath`
(`utils/postmortem/rules.js:190-197`, used at `utils/postmortem/series.js:50`), which only asks
whether the file is there and in the declared shape. So the translator of volume 3 sees the glossary
as it stood when volume 3 was built, and a term that volume 11 settled differently never reaches
volume 3's file.

**Weakness two — a terminology correction that does happen never reaches the chapters already
written.**
Across all 17 glossaries the previous run produced, **exactly 2 of 555 distinct terms changed
rendering** (`/tmp/opencode/measure-rendering-revisions.js` → `out-revisions.txt`):

| term | rendering by volume |
|---|---|
| `百花祭` | "Hyakusai Festival" (v1) → "Hyakka Festival" (v2–v17) |
| `夫人界のアガシ` | "*Agassi of the madam world*" (v3–v10) → "*Agassi of the Lady world*" (v11–v17) |

Both corrections reached **every later glossary file**. Whether the already-written chapters were
re-translated cannot be checked directly — **no translation from that run survives on disk** (the opening note above §1) —
but the mechanism that would have caught it exists and works, and it cannot fire backwards:
`chapterContextHash` (`utils/translate/references.js:286-299`) keys each chapter on the glossary rows
*that chapter actually uses*, so a changed term invalidates exactly the chapters that print it and no
others — and it only fires forward, because an earlier volume's own `glossary.md` is never rewritten
after it is published.

**A correction to what this plan was dispatched with.** The dispatch says the supersede door "is
never called from the glossary route", and `AGENTS.md`'s glossary row still says
**"no later volume can improve a term the record already holds"**. **Both are out of date.** That gap
was closed on 2026-10-13 by item 7 of `glossary/plan/01-glossary-route.md` (recorded there as
"**Built 2026-10-13**", and in gotcha 139). The door is live: `fileGlossaryRevisions`
(`glossary/store.js:326`, called from `glossary/task.js:461` and `glossary/chunked.js:85`) →
`importGlossaryRevisions` (`utils/reference-store/glossary-adapter.js:918`) → `fileGlossaryRevision`,
which inserts a replacement row with `supersedes: current.id` and marks the old row superseded in one
transaction (`glossary-adapter.js:854-892`), and **refuses** any revision whose quote is not a line of
this volume's own source text (`glossary-adapter.js:841-852`, rule `revision-quote-not-in-source`).
The offline loop proves it end to end: *"revisions: 1 filed and 1 refused end to end; volume 02's
record holds 2 row(s) for the revised term, its published glossary prints the new rendering and names
the one it replaced."*
So the missing half is **not** the door that changes a term. It is the backward half: nothing names
the already-written chapters a change invalidates (§6.2), and nothing tells the translator of volume
3 that the term it was given is no longer the answer. **`AGENTS.md` line 75 needs that stale sentence
removed** — this slice did not edit `AGENTS.md`.

**And the stage's own feedback door has no handle on the other side.**
`verify-translate` writes contested renderings into `glossary-disputes.json` at the series root
(`utils/disputes.js:33-34`, written by `verify-translate/task.js:281` `collectGlossaryDisputes`).
The translator reads that queue and marks the term provisional in the prompt
(`utils/translate/references.js:250-251`), and `glossary/task.js:343` prints a pointer to it.
**Nothing resolves it.** In the reference store, `challengeFact` (`utils/reference-store/facts.js:719`)
is called from exactly one place outside tests — `utils/reference-store/attribution.js:677` — and
`resolveChallenge` (`utils/reference-store/facts.js:888`) has **no caller outside tests at all**:
no command, no stage. A dispute opened by `npm run attribute-voice` cannot be closed through any
door a person can type.

**Weakness three — the stage's cost has never been measured either.** It is the most expensive
stage in the pipeline and there is no run log for it. §3 measures the shape of it for the first
time.

---

## 2. What the stage is today

Three gulp steps in the default run (`gulpfile.js:453-455`): `translate` → `translate-qa` →
`polish`. `verify-translate` and `retranslate` are not steps of their own; they run inside
`translate-qa`'s half-rounds (`translate-qa.js:269-270`).

**Nine model-call sites in the whole stage** (`grep -rn "runOneShot(" translate/ verify-translate/
retranslate/ polish/`):

| Site | What it asks |
|---|---|
| `translate/volume.js:457` | one chapter part, the `TRANSLATE_*` endpoint |
| `verify-translate/grade.js:138` | one chapter's 0–100 grade, `VERIFY_*` |
| `verify-translate/volume.js:152` | the borderline tiebreak re-grade, `AUDIT_*` |
| `verify-translate/consistency.js:197` | one window of a volume's published chapters, `AUDIT_*` |
| `retranslate/chapter.js:369` | a whole failed chapter, `TRANSLATE_*` |
| `retranslate/targeted.js:145` | one quoted passage, `TRANSLATE_*` |
| `polish/phase-a.js:173` | one chapter's surface polish, no source text, `EDIT_*` |
| `polish/audit.js:101` | one polished candidate, source-aware, `AUDIT_*` |
| `polish/repair.js:106` | a failed audit's findings injected back, `EDIT_*` |

**The chapter-part plan, measured against the real books**
(`/tmp/opencode/measure-switches-and-calls.js` → `out-switches.txt`, using `createChapterPlanner`
with this machine's `.env`):

- 17 volumes, **133 chapters**, **2,450,316 source characters**, **~1,477,922 estimated source
  tokens** (the repo's own weights: 0.69 per CJK char, 0.25 per other).
- **133 parts → 133 translate calls. Zero chapters split.** Largest chapter: volume 16 ch3,
  47,930 chars / 33,200 est tokens.
- The binding limit is **admission**, not feasibility (`utils/translate/split.js`): the part
  ceiling the plan allows is **80,332 characters**, more than any chapter in the series.

**A planner/reality mismatch found while measuring it.** The planner's output reserve comes from
`ctx.endpoint.maxTokens || harness.envMaxTokens()` (`translate/volume.js:80`), and with no
`TRANSLATE_MAX_TOKENS` set that is `AI_MAX_TOKENS` = **131,072** (`ai/env.js:97`). The call itself
passes `maxTokens: endpoint.maxTokens` (`translate/volume.js:465`) — which is **null** when the role
sets no override — and `ai/one-shot.js:214-217` then derives `floor(contextWindow / 4)` =
**65,536**. The plan is built against an output budget **twice** the one the request can use. It
does not change the answer here — admission binds either way and no chapter splits — but it means
the admission margin the plan reports is not the margin the server sees.

**What a chapter is actually shown** (`/tmp/opencode/measure-chapter-terminology-load.js` →
`out-terms.txt`):

| | volume 01 (137-row glossary, on disk) | volume 17 (554-row glossary, from the tag) |
|---|---|---|
| chapters | 10 | 6 |
| terms present per chapter | avg 21.4, max 46 | avg 34.7, max 42 |
| injected terminology block | avg 595 chars, max 1,265 | avg 982 chars, max 1,283 |
| chapters where the 12,000-char cap cut terms | **0 of 10** | **0 of 6** |

Two things follow. The terminology budget is **not** the constraint — it never fires, not even
against the 554-row cumulative file. And the glossary is mostly **not** this volume's vocabulary:
**439 of the 554** terms in the tag's volume-17 glossary do not occur anywhere in volume 17's own
text. The per-chapter selection (`chapterTerminology`, `utils/translate/references.js:317`) is
already doing the work; the file it selects from is the part that is wrong.

Reference caps in code, for the record: glossary 12,000 chars (`utils/translate/terminology.js:203`),
shared wiki 8,000 + volume wiki 6,000 + POV map 2,000 (`utils/translate/references.js:166-178`),
voice notes 4,000 (`references.js:235`), continuity tail 400 (`translate/config.js:48`) —
**32,400 characters of reference material before the token fit is applied.**

**Three of those six blocks are empty today, and five of the six are empty in the live corpus.**
No `style-guide.md`, `wiki.md` or `shared-wiki.md` exists anywhere in the corpus or in the tag;
`character-voice.md` and `pov-map.md` exist in the tag for volumes 01–02 only
(`/tmp/opencode/measure-translation-stage-size.js` → `out-size.txt`). In the live corpus, **only
volume 01 has a `glossary.md` and a `series.db`** — volumes 02–17 have neither, nor a voice
reference, nor a POV map (`for d in 俺を好きなのはお前だけかよ*; do … done` over the corpus root).
A translator started today would run against one volume's worth of terminology law and nothing
else.

**Two doc statements this measurement found worth tightening** (this plan changes neither):
`docs/pipelines.md` §8.5 says the stage runs per chapter on "segment ids from `chapters.json` /
the source bundle" — the stages iterate `bundle.segments` from `*-bundle.meta.json`, and
`chapters.json` is only ever *compared* to that list (`checkChapterListConsistency`,
`utils/translate/progress.js`) or read by `measureOutputRatio`; and the same section's "the volume's
cumulative glossary" is true of the file and misleading about the record, because the file is a
snapshot of the terminology **as of that volume** (§1). Separately, `docs/environment.md:90` gives
`TRANSLATE_QA_MAX_ROUNDS` a default of 3 while this machine's `.env` sets **5** — the 21- and
23-switch rows above were computed with 5, which is what a run on this machine actually does.

---

## 3. The container switches, and the cost nobody has measured

This machine runs one model per port and swaps containers between roles through `hooks/`.
`utils/hooks.js` fires `pre-<step>` / `post-<step>` around every gulp task, and the stage adds
three inner hooks of its own: `verify-audit` (`verify-translate/task.js:193`), `polish-audit`
(`polish/task.js:147`) and `polish` (`polish/task.js:163`).

**The hooks that exist here** (`ls hooks/`, `out-switches.txt`): `pre/post-translate`,
`pre-verify-translate`, `pre-verify-audit`, `pre/post-retranslate`, `pre/post-polish`,
`pre-polish-audit`, `pre-manager`. **`post-verify-translate` does not exist**, and **no
pre-production step has a hook at all** — the glossary, voice, style, wiki and audit stages all
run on whatever container happens to be up.

**Switches a full default run pays** (same script, simulating the hook rule against this
machine's hook files):

| Scenario | Switches |
|---|---|
| everything passes first time (1 QA round, 1 polish audit round) | **6** |
| QA round cap hit (5 rounds), polish passes round 2 | **21** |
| both caps hit (5 QA rounds, 3 polish rounds) | **23** |

**The cost of one switch is unmeasured, and that is the first thing this plan has to fix.**
There is not one `[hooks]` line in any log under `/mnt/windows/weeb/oresuki/.run/logs/`
(`grep -rh "\[hooks\]" .run/logs` → 0 hits), so no run on this machine has ever recorded a switch.
What can be said without inventing anything:

- `hooks/model-switch.sh` asks for at most `docker stop -t 30`, then waits up to **60 × 1 s** for
  the port to free, then polls `/health` every **5 s** for up to **900 s**.
- The serving engine's own log — `/home/muggy8/Containers/Strata-Qwen3.8-flash-next/IQ3_XXS/strata-engine.log`
  — records **74 restart cycles: minimum 101 s, median 179 s, 70 of 74 at or under 200 s**,
  loading 39.97 GiB at 0.50 GiB/s.
- Container sizes on disk: index-translate **21.7 GB**, beellama-Qwen3.8-27b **14.25 GB**,
  Strata-Qwen3.8-flash-next **75.8 GB** (47.0 + 28.8).

Taken as an anchor rather than a measurement, 6 switches at the engine's own median is roughly
**18 minutes of dead time on a clean pass**, and 23 switches on a worst-case pass is roughly
**70 minutes**. Those two numbers are **arithmetic on an anchor, not a measurement of a switch**,
and slice 0 exists to replace them.

**Why this decides the batching question.** The stage is already batched — one endpoint per batch,
never interleaved (`verify-translate/task.js:182-250`, `polish/task.js:133-177`), and the docs say
a 17-volume run "used to pay 17 switches for a pass that needs one". The remaining switches are
the **round boundaries**: each QA half-round and each polish audit round switches containers.
Whether it is worth batching harder — one QA round per endpoint instead of per half-round, or
grading the tiebreak on the verify endpoint and dropping the cross-model check — depends entirely
on what a switch costs. **That is why this plan does not design the batching.** Designing it
before measuring the switch is guessing at a trade whose price is unknown.

---

## 4. The idea worth having: choose the rendering before the reveal

The account owner's question, restated: the glossary already carries notes that say a term's
meaning or name is settled **later** — could the stage ask, once, what the eventual rendering
should be, and hold it as a proposal until the book confirms it?

**The candidate set must come from recorded facts, never from a model guessing which terms matter.**
Two sources exist on disk, and both were measured:

1. **A term a later volume actually revised.** 2 terms across 17 volumes (§1).
2. **A term whose own note points forward.** Scanning the 17 tag glossaries — **5,392 data rows**
   across 119 section tables — with a deliberately wide marker net ("later", "will be", "recurring",
   "foreshadow", "track for consistency", …) names **25 distinct terms**
   (`/tmp/opencode/measure-note-forward-references.js` → `out-notes.txt`). The dispatch's figure of
   5 came from a narrower pattern over the same rows, not from a smaller population; the 25 are what
   the wide net finds, and §11 records that the two nets were not compared term by term.

The union is **2 revised + 25 forward-noting, 0 overlap → 27 candidate terms for the whole
17-volume series** (`/tmp/opencode/measure-foresight-candidates.js` → `out-foresight.txt`).

**The new pipeline's own output bites too.** Volume 01's *rendered* 137-row glossary — the file the
new store route published, not the old authored one — has **12 rows whose note points forward**,
including `図書室` ("a reason that will be explained later") and `黒い蓮の花` ("likely foreshadowing
… track for consistency in later volumes"). So this is not a problem inherited from the old
artifacts; it is one the current route keeps producing.

**What one bounded, tool-less one-shot costs on this machine.** The only comparable real calls on
disk are the 12 `glossary-research` calls in `.run/logs/`: prompt mean **2,705**, completion mean
**1,257**, total mean **3,962**, median **4,088**, range 1,894–5,934; all 12 together **47,544
tokens**. Twenty-seven candidates at that measured mean is **~107,000 tokens for the whole series**
— an estimate built from measured inputs, not a measured cost.

**The shape this has to take, and the shape it must not.**

- It is **one bounded pass over a list code produced**, not a stage, not an agent, and not a search
  for candidates. The bound is a constant with no environment knob, the same way
  `RESEARCH_MAX_TERMS_PER_VOLUME = 12` and `GUIDE_SPLIT_MIN_PIECES = 2` are bounds
  (AGENTS.md §4.3).
- Its answer is a **proposal filed in the record**, never a rewrite of a published row. **Neither
  existing door fits a guess, and that is the design problem.** The glossary's own revision door
  requires a quote that is a line of this volume's source text
  (`utils/reference-store/glossary-adapter.js:841-852`) — a foresight answer about a book that has
  not been read yet has no such quote, so it is refused by design. The store's challenge door,
  `challengeFact` with `supersede` defaulting to false
  (`utils/reference-store/facts.js:705-712`), leaves the published claim in force but marks it
  **`disputed`**, which changes the prompt of every chapter that uses the term
  (`utils/translate/references.js:295`). Marking a confirmed rendering disputed because of a guess is
  the guard doing damage. Which door the answer goes through is question 3 in §9, and it is the
  account owner's.
- It is **checked when the reveal arrives**, not trusted. The term's proposal becomes the law only
  when a volume's own text — through the evidence rule the store already enforces at filing —
  confirms it.
- It must **not** become a model predicting plot. The question it asks is narrow and answerable
  from the material in hand: *given this term, this note, and this volume's text, what English
  rendering should the translator use if this term turns out to be what the note suggests?* The
  question "what happens later in the series" is not askable and is not asked.

---

## 5. The freeze, and the hole in it

`utils/prereqs/freeze.js` refuses to let any pre-production step **rewrite** an artifact a
published `translation.md` was built on. That is the correct rule, and this plan does not touch it.
Two consequences have to be designed for, not discovered later:

1. **A foresight proposal cannot legally rewrite a published volume's glossary.** That is fine — it
   should not. But it means the plan needs an answer to "volume 7 is translated, and volume 9
   settles a term differently": the answer is **contest the row and let the delivery layer route
   the damage**, not re-run volume 7. `utils/postmortem/plan/01-finding-levels.md` already has the
   level for that (`reference-evidence-does-not-verify` and the cumulative-damage kinds are
   STOP/MAJOR), and `npm run release-translation` is the only door past the freeze, and it is the
   account owner's, not the pipeline's.
2. **The known hole stays a hole.** The manager's `wipe-and-cascade` deletes a volume's outputs and
   the re-run that follows is excused as *filling a hole* (`utils/prereqs/freeze.js`, AGENTS.md
   §1). Closing it changes the closed action menu and is the account owner's decision. This plan
   records it and does not widen it.

---

## 6. The target shape

Five changes, in the order they have to land.

**6.1 The translator reads the record, not a file. — BUILT (2026-10-13, slice 1).**
`readReferenceFiles` (`utils/translate/references.js`) now reads **five** files from the volume
folder; the glossary is not one of them. `utils/translate/settled-glossary.js` resolves the
**settled record** — the highest-numbered volume `series.db` on disk, each candidate asked which
volume it is out of its own `volumes` row — and `readSettledGlossary` asks it for the rows in force
at **its own** volume, which is the newest row of every supersede chain. `renderGlossary` of those
same rows is what the stage carries as `glossaryText`, so the published file for humans and the
machine-facing law are the same render of the same rows, and `compareSettledGlossary` checks the two
published files against it at translation time with 0 model calls. **A missing or unreadable record
refuses structurally; there is no fallback to the markdown and no knob on the decision.** The other
five references stay file-based on purpose: `shared-wiki.md` is the story state *through this
volume*, and the series-root copy is the LATEST volume's state — a settled rendering is not a
spoiler, a later volume's plot is. → gotcha 143.

**6.2 A term→chapter index, so a revision can name what it invalidates.**
There is **no such index anywhere**. The reference store has no term-presence table and no
translation table; `cast_presence_match` (`utils/reference-store/schema.js`) is cast-only. Without
an index, "which already-written chapters print this term?" is unanswerable, and that is the
question a correction needs. `chapterTerminology` already computes the answer per chapter at
translate time (`utils/translate/references.js:317`) — it just throws it away after the hash.

**6.3 A dispute door a person can type.**
`resolveChallenge` exists and is tested (`test/test-reference-store-ownership.js`,
`test/test-reference-store-attribution.js`) and has **no command in front of it**. A
`resolve-glossary`-style command that closes a `challenge_fact` row and re-renders the glossary is
the missing half of the loop the verify stage already opens.

**6.4 The bounded foresight pass, behind its own command.**
Not a stage, not in `PIPELINE_STEPS`, not called by any stage — the same placement
`attribute-voice.js` was given (AGENTS.md §1: "No stage calls it"). Its candidate list is built by
code from §4's two recorded sources. Its answer is filed as a proposal.

**6.5 Batching — only after slice 0.**
What to batch, and whether the cross-model tiebreak is worth a switch, is decided by the measured
switch cost. This plan deliberately stops there.

---

## 7. Build order

**Slice 0 — measure the switch. A measurement, not a feature.**
Time one `model-switch.sh` end to end, three times, **without touching the container that is
serving this session's model** (port 9200 is `strata-qwen38-flash-next`, up 37 hours and healthy;
running the switch against it kills this session). The safe door is a rehearsal against a copy of
the hook script pointed at a **spare** container or a fake health endpoint, plus reading the
engine's own restart log for the containers the stage actually swaps. Deliverable: a number in
this plan, replacing the anchor in §3. **Nothing else in this plan should be scheduled until slice
0 reports.**

**Slice 1 — which glossary the translator reads. — BUILT (2026-10-13).**
`readReferenceFiles` no longer reads `glossary.md`; `utils/translate/settled-glossary.js` reads the
settled record and `loadVolumeReferences` hands the stage that render, with `refs.terminologySource`
naming the record it came from. Built first against a 3-volume fixture, red before green: with
`utils/translate/references.js` stashed, 6 of the 9 scenarios fail, including the one that matters —
volume 1's chapter was being translated under `百花祭→Hyakusai Festival`, the rendering volume 3 had
replaced. Measured, **0 model calls**: the new suite `test/test-translation-terminology-source.js`
(9 scenarios, 62 checks); the offline loops unmoved at **81 calls / 16 prompt kinds** and
**27 / 5**, second pass **0** in both, prompt audit **23 checks / 0 findings** in both. Against a
**copy** of the real volume 01 record: **137 settled rows, 0 supersede chains, a 43,597-byte render,
driftCount 0**, and the comparison says out loud that no series-root `glossary.md` exists. The two
real revisions replayed on the fixture — `百花祭` "Hyakusai Festival"→"Hyakka Festival" and
`夫人界のアガシ` "Agassi of the madam world"→"Agassi of the Lady world", both published at volume 1 and
settled at volume 3 — move the per-chapter key for **exactly** the chapters that print them: 1 of
volume 1's 2 chapters, 1 of volume 2's 1, 1 of volume 3's 1; the chapter that never prints a revised
term keeps its draft. **On the live corpus the honest answer is still 0 chapters, because no
translation exists** (0 `translation.md` files), and that is said here rather than dressed up.
What the slice deliberately did **not** do: the other five references stay file-based; the
published-file/record disagreement is **printed, not filed** (a stage's own finding list never reaches
the post-mortem — gotcha 138 — so the level table stays at 68 kinds); and
`REFERENCE_SELECTION_VERSION` was not bumped, because bumping it moves every chapter's key, which is
the opposite of what the per-chapter key exists to prevent. → gotcha 143.

**Slice 2 — the term→chapter index.**
Record which terms each chapter was translated with, in the store, and make "which chapters print
this term" a query. Prove it by replaying the two real revisions: `百花祭` and `夫人界のアガシ`,
and reporting exactly which already-written chapters each one would have invalidated. On today's
corpus the honest answer is **0 chapters**, because no translation exists — so the proof runs
against the tag's artifacts or a fixture, and that has to be said out loud rather than dressed up.

**Slice 3 — the dispute door.**
A command in front of `resolveChallenge`, plus the re-render it implies. Prove it closes a real
`challenge_fact` row opened by `attribute-voice` and leaves the published row's history intact.

**Slice 4 — the bounded foresight pass.**
Build the candidate list from §4's two sources, bound it with a constant, ask one tool-less
one-shot per candidate, and prove the second pass costs **0 calls** over the same candidates — the
same idempotency guarantee `attribute-voice` has. **Where its answer is filed is not decided** (§9
question 3): the glossary's revision door refuses it for having no quote from the book, and the
store's challenge door would mark a confirmed rendering `disputed` on the strength of a guess.

**Slice 5 — batching, if slice 0 says it is worth it.**
Not scheduled, not designed.

---

## 8. The numbers this has to produce

| Number | Today | Source |
|---|---|---|
| chapters in the series | 133 | `out-size.txt` |
| translate calls for a clean pass | **133** (1 part per chapter, 0 splits) | `out-switches.txt` |
| container switches, clean pass | **6** | `out-switches.txt` |
| container switches, worst pass | **23** | `out-switches.txt` |
| cost of one switch | **unmeasured** — anchor 101–200 s | `strata-engine.log` |
| terms whose rendering changed in 17 volumes | **2 of 555** | `out-revisions.txt` |
| terms whose note points forward | **25** (tag) / **12 of 137** (volume 01, rendered) | `out-notes.txt`, `out-foresight.txt` |
| glossary terms a chapter is actually shown | avg 21.4 (v1) / 34.7 (v17) | `out-terms.txt` |
| chapters the terminology cap truncates | **0 of 16** | `out-terms.txt` |
| tag glossary terms absent from their own volume's text | **439 of 554** | `out-terms.txt` |
| cost of one bounded one-shot | mean **3,962** tokens, median **4,088** | `.run/logs` research calls |
| a full clean translation pass, in calls | **~532** (133 translate + 133 verify + 133 polish + 133 audit) — **computed from the measured chapter count and the measured part plan, not measured**; the tiebreak, sampling, consistency-window and retranslate calls on top are unmeasured | §2 |
| a full clean translation pass, in tokens | **unmeasured** | — |

The offline loop baselines this plan must not move: **81 calls / 16 prompt kinds**, and the
chunked-glossary loop **27 calls / 5 kinds**. Measured green on 2026-10-13 at HEAD `86aac7d`
(`/tmp/opencode/translation-plan-npmtest.log`, `EXIT=0`, "total model calls: pass 1 = 81, pass 2 =
0" and "pass 1 = 27, pass 2 = 0"), with nothing in the repository modified at the time.

---

## 9. Open questions, said plainly

Written out in `/tmp/opencode/translation-plan-questions.md` before any of them is answered.

1. **Which glossary does the translator read** — **ANSWERED by the account owner on 2026-10-13, and
   built (slice 1)**: the record as it stands now, newest wins everywhere. The owner's words were
   "the translator should obviously make use of the final revised version of the glossary … this way,
   as much of the foreshadowing is preserved as possible." The freeze (gotcha 142) is what the answer
   interacts with, and it holds: a published `translation.md` still freezes the artifacts it was built
   from, so re-running a pre-production door on a translated volume is still refused per volume.
2. **Is 27 the right bound, and is a per-volume cap the right shape?** The candidate list is a
   series-wide fact, but every other bound in this repo is per volume.
3. **Where does a foresight answer get filed?** Neither existing door fits it. Through
   `challengeFact` it marks the published row `disputed`, which changes the prompt the translator
   sees for every chapter using that term (`utils/translate/references.js:295` puts "disputed" in
   the chapter's own hash). Through the glossary's own revision door it is **refused**, because that
   door requires a quote from this volume's book (`utils/reference-store/glossary-adapter.js:841-852`)
   and a guess has none. The third option is a new, softer row kind that carries no consequence
   until a volume's own text confirms it — which is a schema change in a banned patch path
   (`utils/reference-store/`), so it is the account owner's call.
4. **Is the `foresight` prompt kind added to the prompt audit?** Adding it moves a call baseline,
   which AGENTS.md §4.11 treats as a real change, not a cosmetic one.
5. **Does the translation stage get a record of its own** (a store for renderings used per chapter,
   which is what §6.2 needs), or does the index live in the existing reference record?
6. **Is the cross-model tiebreak worth a container switch** — 133 chapters re-graded on a second
   model, paid for in restarts — or should borderline chapters be re-sampled on the same model,
   which `repeatBorderlineSamples` (`verify-translate/task.js:153`) already does for repeat samples?

---

## 10. What this must not become

- **Not a model that predicts the plot.** It answers a rendering question about a term the record
  already flagged. It is never asked what happens later.
- **Not a second translator, and not a rewrite of published text.** A published row is contested
  through `challengeFact`, never edited (AGENTS.md §4.5, `facts.js:615`).
- **Not a whole-glossary injection.** The measured per-chapter load is 595–982 characters against a
  12,000-character cap that never fires; the fix is the *set of terms*, not a bigger block.
- **Not a stage.** No entry in `PIPELINE_STEPS`, no stage calls it, no environment knob on its
  bound (AGENTS.md §4.3).
- **Not a model grading what code can check for free.** Which chapters print a term, which terms a
  volume's text actually contains, and which rows are in force are all computable; none of them
  may become a prompt.
- **Not a reason to weaken the freeze.** `utils/prereqs/freeze.js` and the `wipe-and-cascade` hole
  in it are the account owner's, and this plan leaves both where they are.

---

## 11. What has never been measured, and this plan does not pretend otherwise

- The cost of one container switch (§3). **Slice 0.**
- The token cost of any translation pass on any real book — no `translation.md` has ever been
  written on this corpus, and no translation-stage call appears in any run log.
- How many chapters the tiebreak band, the repeat sampling and the consistency windows actually
  produce calls for. The bands exist (`VERIFY_TIEBREAK_BAND`, `VERIFY_SAMPLE_BAND`,
  `VERIFY_SAMPLES`) and their firing rate on the real books is **unmeasured**.
- Whether the cross-model tiebreak and the cross-chapter audit improve any score measurably. Both
  are documented as fixes for real failures; neither has a before/after number.
- Whether the 25 forward-noting terms are the *right* 25. The marker net is deliberately wide, and
  a narrower net was not measured against it.
