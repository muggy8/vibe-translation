# Proposal: one working file per character, assembled into the published reference

**Status: PROPOSAL. Nothing here is implemented.** This file describes a shape the
character-voice stage *could* have. `docs/map-preproduction.md` and `docs/pipelines.md`
still describe what the code actually does today, and this file must not be read as current
behavior.

Written 2026-10-10, from a live failure on the 17-volume series at `SERIES_LOCATION`
(`俺を好きなのはお前だけかよ`), run `delivery-2026-10-09T20-32-14-749Z`.

---

## 1. Plain-language summary (for the account owner)

The stage builds one big shared document. Every chapter's agent is told "open the whole
document, find the part you need, change it in place". On volume 01 that document reached
118,000 characters, and one single line of it reached **54,341 characters (157,566 bytes)** —
because an agent's cleanup edits deleted line breaks along with the text they were wrapped
around. (Re-measured 2026-10-10 against the file on disk. The 157,566 figure this document and
`04-implementation-plan.md` §2 carried for months is that line's **byte** length; its character
length is 54,341. Same line, wrong unit — and the unit matters wherever the number is compared
with a limit stated in characters.)

The harness only lets an agent see the first 8,000 characters of any line. So the agents
were repairing a document they could not read. They re-read it 20–24 times per chapter,
made 29–40 edits per chapter, filled the model's working room, and the model server refused
the request outright. Volume 01 cost 13 hours and 172 million tokens, scored 48/100, and
volumes 02–17 never started.

The proposal: make **one file per character** the working unit, let agents rewrite a whole
small file (which is safe), and have the pipeline assemble `character-voice.md` from the
parts with no model involved. Every downstream reader keeps seeing the same file.

---

## 2. The incident, with the evidence

| fact | where it is recorded |
|---|---|
| volume 01 ran 13h (13:32 → 02:28 local) and died mid-QA-round | `.run/logs/2026-10-09T20-32-15-343Z/summary.log` |
| 171,843,556 tokens billed, 37 model calls, one volume | same log, `RESULT` lines |
| acceptance grade **48/100**, band "Requires revision" | `one-shot/character-voice-acceptance-01-1.md` |
| the grader named the damage: "corrupted tail (220 lines of duplicated fragments)" | same file |
| the volume was published anyway | `ON_QA_LIMIT` default; post-mortem finding `accepted-without-acceptance` in `.run/postmortem/character-voice.md` |
| the repair agent for chapter 4 was refused by the server | the model server's own log: `400 invalid request: prompt (263012 tokens) leaves no room to answer in the context (262144)` |
| just before that, calls had ~10k tokens of room and the answer was cut off mid-tool-call | server log: `writing a tool call: editFile: 10310 of max 10376 … done: 10376 (length)` |
| the artifact is structurally destroyed | `俺を好きなのはお前だけかよ(01)/character-voice.md`: 106 lines, longest line **54,341 characters (157,566 bytes)**, 3 `### ` headings, 0 `## ` headings |
| every *freshly written* artifact is healthy | `character-voice-validation.md` 464 lines / longest 4,494; `character-voice-validation-ch3.md` 119 / 2,380; `pov-map.md` 191 / 1,775 |
| the agents could not read the document | `agent-feedback-author-01-1-ch3/turn-001.md` contains "truncated at 8000 chars" **83 times**, including "That makes editFile risky since I need exact strings." |

### 2.1 How a 54,341-character line gets made

From `summary.log`, the chapter-3 repair agent:

```
editFile  oldString: "\nin**: Volume 01（あとがき＝ch7.2）\n"   newString: ""   replaceAll: true
editFile  oldString: "\ne 01（あとがき＝ch7.2）\n"             newString: ""   replaceAll: true
```

A search string that includes the line break on **both** sides of the junk, replaced with
nothing, welds the neighbouring lines together. Repeated with `replaceAll: true`, on a
document the agent can only see 8,000 characters of at a time, that is a monotone
destruction of the file's line structure. The agent was trying to remove corruption and each
attempt made the file less readable, which made the next attempt blinder.

### 2.2 The agents re-trod old ground (this is measured, not inferred)

Each repair agent was told "apply ONLY the findings tagged with chapter `<id>`". The chapter
mentions inside their own tool calls:

| agent | own chapter | other chapters |
|---|---|---|
| ch0 (prologue) | 14 × 第一章 | 24 × 第三章, 20 × 第七章, 11 × 第二章, 9 × 第四章, 9 × 第六章 |
| ch1 | 52 × 第一章 | 14 × 第三章, 12 × 第二章, 10 × 第七章, 6 × 第四章, 5 × 第六章, 4 × 第五章 |
| ch2 | 54 × 第二章 | 43 × 第一章, 17 × 第七章, 13 × 第三章, 12 × 第六章, 11 × 第四章, 11 × 第五章 |
| ch3 | 118 × 第三章 | 27 × 第四章, 22 × 第五章, 21 × 第二章, 12 × 第七章, 11 × 第一章, 9 × 第六章 |

The prologue's agent worked harder on chapters 3 and 7 than on its own chapter.

### 2.3 Where the tokens went

| stage | calls | tokens | note |
|---|---|---|---|
| extract (one-shot per chapter) | 10 | 1,103,160 | **0.6% of the run.** Chapter-scoped, no re-treading, worked perfectly |
| compile (amend the shared document) | 10 | 50,811,712 | |
| validate (audit the whole document against one chapter) | 10 | 60,299,124 | + 4,077,180 recovery |
| findings merge | 1 | 1,603,030 | |
| acceptance grade | 1 | 293,032 | |
| feedback (repair the shared document) | 4 (died at ch4) | 53,656,318 | |

The stage that matches the intended mental model — read one chapter, record only what that
chapter reveals — is essentially free. **Every expensive stage is one where an agent must
hold the whole shared document.**

---

## 3. Root causes, each with its location

1. **The chapter split divides the source, not the artifact.**
   `character-voice/prompts.js` → `buildFeedbackTurnPrompt` hands each chapter's agent
   `character-voice.md` (118,218 chars), `pov-map.md` (24,205, rewritten whole), and the
   **merged whole-volume** report `character-voice-validation.md` (109,564), plus its own
   22,141-char chapter. ~230,000 characters, to an agent meant to handle one chapter.

2. **The chapter's own audit slice already exists and is not used.**
   The per-chapter partials are written to disk — `character-voice-validation-ch3.md` is
   **41,910 bytes** against the merged report's **244,609** — and the prompt points at the
   big one and then says "apply only the findings tagged ch3". Pure waste, independent of
   any redesign.

3. **A cumulative document amended in place is not readable under the harness's own limits.**
   `ai/env.js` → `envMaxLineLength()` = 8,000 characters per line. The reference format
   writes long lines (the env note records 2,344 chars at volume 02, 2,863 at volume 03 —
   fine). Once line breaks are destroyed, a 54,341-character line shows 8,000 of its characters
   to an agent — 15% of it. (The 5% this document quoted came from dividing 8,000 characters by
   the line's 157,566 BYTES; the honest figure is 15%, and the point stands either way.) The
   agent is
   instructed "read the section you are about to change before changing it"
   (`character-voice/reference-index.js` → `voiceIndexBlock`) and physically cannot.

4. **The repair path is the one path with no per-chapter guard — and it is where the damage happened.**
   The **compile** path is guarded properly, between chapters, with a same-volume baseline
   (`character-voice/chunked.js` lines 65–79):
   ```js
   const chapterBaseline = await fs.readFile(ctx.voiceOutputFile, "utf8").catch(() => null);
   await runCompile(ctx, extractionOutput, segment, si);
   if (chapterBaseline !== null) {
     await guardVoiceCarryForwardAgainst(ctx, chapterBaseline, `the compile pass (chapter ${segment.id})`,
                                         "the reference as of the previous chapter");
   }
   ```
   That works on volume 01 too, and it is why all 10 compile passes passed.
   The **QA/feedback** path has no such hook. Its only guard is
   `character-voice/chunked.js` line 182 — `afterFeedbackRound: () => assertVoiceCarryForward(ctx, …)` —
   and `assertVoiceCarryForward` (`character-voice/carry-forward.js` line 166) begins:
   ```js
   if (isFirst || !previousVoiceRefFile) return;   // volume 01 → returns immediately
   ```
   So on volume 01 the repair round — the round that produced the 54,341-character line — ran
   with **no deterministic structural check at all**, and on later volumes a repair chapter's
   damage becomes the next repair chapter's baseline. The only thing that noticed was the AI
   grader, and `ON_QA_LIMIT` published it anyway.

5. **The heading-counting guard is fooled by exactly this damage.**
   `parseVoiceSections` matches `^###\s+`. A heading welded into the middle of a long line
   no longer matches. The file ended with 3 headings where the index had listed 9. A
   section-count comparison over a destroyed document cannot see the loss.

6. **Delivery-layer dead end (separate bug, separate fix).**
   `autopilot/loop.js` → `movesAfterFailures` removes the `run` move for any step this
   invocation ran and lost. `openTheTicketThePlanProposes` only writes a ticket when the plan
   step's action is `ticket`. The triage correctly did *not* escalate, because
   `utils/ledger/decide.js` counts only `unchanged`/`worse` as unhelpful and this attempt was
   `improved` (0 → 1 volumes built). Result: the menu was `escalate` + `end` only, and the
   manager's own transcript says so — "the triage says resume… but my tool menu here lacks
   it". The loop's message promises "the team that can read why it failed" and never creates
   the ticket that team needs.

---

## 4. The proposal

**Split for reading and writing. Never split the published artifact.**

```
working unit (new)      <volume>/character-voice/
                          如月雨露.md            one file per character (persona variants included)
                          日向葵.md
                          _index.md              who exists, with aliases and persona tags
                          _meta.md               the "current through volume/chapters" header

per chapter:
  1. harness picks the characters this chapter touches        (deterministic, no model)
  2. agent is handed ONLY those files + its own audit slice   (a few thousand chars each)
  3. agent rewrites whole small files, or returns diffs       (safe: a small file fits one reply)
  4. harness diffs the folder against the pre-chapter snapshot (deterministic loss guard)
  5. harness assembles <volume>/character-voice.md from the parts (no model)

published artifact      <volume>/character-voice.md           unchanged shape, unchanged name
                        <series>/character-voice.md           unchanged root copy + provenance
```

### 4.1 Why this is the right unit, not a new invention

`character-voice/carry-forward.js` already defines the invariant unit as **one `### Character`
section keyed on `voicePrimaryName`** (aliases and persona tags stripped:
`如月雨露（ジョーロ）【俺人格】` → `如月雨露`). Per-character files materialize the unit the
code already reasons in.

And the repo already states the principle this proposal extends, in its own words:

> "Carry forward every previous entry" was never a job for a model: it is a file copy.
> — `character-voice/carry-forward.js`, on `seedVoiceReferenceFromPrevious`

The seed already refuses to make a model retype carried-forward work **across volumes**. This
proposal applies the same rule **within** a volume.

### 4.2 The distinction the current design conflates

```
KEEPING earlier information   = a property of the FILE
SEEING  earlier information   = a property of the model's head
```

An agent does not need chapter 1's description of a character in its head in order to not
destroy it. It needs nobody to rewrite the part of the file where it lives. The accuracy
concern — "a character's voice drifts because the agent never saw how they talked at the
start" — is a concern about *keeping*, and keeping becomes a file operation instead of a
model behavior.

### 4.3 What this makes safe that today is forbidden

`voiceWriteInstruction` currently has to say:

> Do NOT rewrite "character-voice.md" with writeFile. This reference is larger than one
> reply can produce, and a write cut off part-way destroys every character it did not reach.

That prohibition exists only because of the monolith. A character file is ~8–13k characters
(volume 01: 118,218 chars over 9 sections). Whole-file rewrite becomes the *safest* mode, and
the recovery prompts no longer need to walk carefully around a forbidden instruction.

---

## 5. The compatibility contract (what must NOT change)

Everything below reads `character-voice.md` by name. The assembled file must be byte-comparable
in shape to today's, or all of it has to be reworked at once.

- `utils/artifacts/preproduction.js` (lines 104–154) — the declared outputs: per-volume
  `character-voice.md` (required, shape `document`), plus `pov-map.md`,
  `character-voice-validation.md`, `…-rolling-state.json` (required),
  `character-voice-new.json` (expected); series-root `character-voice.md` (required) and
  `character-voice.md.provenance.json` (expected).
- `utils/postmortem/rules.js` — the known-file vocabulary and `hasDocumentShape`.
- `utils/delivery-verify/signals.js` — the `voiceSections` signal; **a dropped `### Character`
  section is damage** in the acceptance test. The assembled file must keep the headings.
- `utils/resume/state.js` + the wipe lists — `wipe-and-cascade` removes *declared outputs*.
  The working folder must be inside the declared outputs of this step, or a wipe leaves stale
  parts behind and the next run rebuilds from them.
- `utils/fs/current-artifact.js`, `utils/fs/output-checks.js`, `utils/fs/provenance.js`,
  `utils/handoff.js`.
- Downstream readers: `style-guide/prompts.js`, `jump-in-wiki/`, `consistency-audit`,
  `utils/translate/references.js`.
- 105 textual references to `character-voice.md` across 30 code files, and 11 prompt files
  (`system-prompts/character-voice{,-feedback,-validator}.md`,
  `user-prompts/character-voice{,-extract,-feedback,-validator}.md`,
  `user-prompts/style-guide.md`, `user-prompts/consistency-audit.md`,
  `system-prompts/volume-consistency.md`, `system-prompts/consistency-audit.md`).

**This is the reason for the assemble-at-the-end shape.** Keeping the published file identical
turns a 105-reference migration into a change confined to `character-voice/`.

---

## 6. The hard problems, honestly

1. **Relational findings belong in two files.** "主人公 starts calling コスモス by a new
   nickname" is one fact about two characters. The harness must route one finding to both
   files, and the loss guard must not read "neither file changed" as "nothing to do". This is
   the main place a naive per-character split loses information, and it needs its own design
   pass.

2. **Cast identity.** Two files for one character (an alias used as a name) is worse than one
   monolith, because the cumulative guard keys on `voicePrimaryName` and would see two
   sections where there is one character. `_index.md` plus the existing alias-resolution logic
   in `compareVoiceCarryForward` has to decide *before* the agent writes whether a name is new.

3. **Persona variants.** A character whose narration changes is several `###` sections today
   (`【俺人格】`, `【僕人格】`). Per-character files must either hold several sections (and the
   unit is really "section", not "character") or become one file per persona. Pick one and pin
   it in a test; the existing tests already assert "a reworded character heading is not a lost
   character, a dropped persona is".

4. **`pov-map.md` is per-volume, not cumulative** (the seed deliberately does not copy it). It
   is currently rewritten whole by every chapter agent — wasteful but not damaged (longest line
   1,775). Options: leave it as one file, or make it per-chapter blocks spliced by the harness.
   Out of scope for the first slice; name the decision, don't make it silently.

5. **The assembled file must be deterministic and reversible.** Assembly is a pure function of
   the folder. It must be possible to re-assemble from the parts after a crash, and to prove
   `assemble(parts) == what the previous run published` for an unchanged folder.

6. **The sandbox.** `createGatedFsTools` confines writes to the volume folder and offers no
   `deleteFile` (gotcha 8, gotcha 60). A per-character folder is inside the volume folder, so
   it is allowed — but the prompts must not advertise a tool the sandbox would refuse, and
   merging/renaming a character file is not something an agent should be able to do.

7. **It does not by itself stop newline destruction.** It contains the damage (one character
   instead of the whole reference) and makes it detectable (a file diff cannot be fooled by
   formatting), but the cheap guard in §7.2 is still worth having.

---

## 7. Two guards worth adding regardless of which design wins

### 7.1 A per-chapter loss guard on the repair path

The compile path already has this shape (`character-voice/chunked.js` lines 65–79 — read the
file before the chapter, run the chapter, compare against what you read). The repair path does
not. Mirror the pattern into the `feedback` stage as `feedback.afterChapter`, using the same
`guardVoiceCarryForwardAgainst` baseline form so volume 01 is covered without a previous volume.
It costs nothing and it is the difference between "one chapter of rework" and "seven chapters
built on a reference that is already missing someone" — which is the case the module's own
docstring describes and the compile path already handles.

### 7.2 A structural plausibility check before publishing

Deterministic, no model: a cumulative reference with a line longer than `envMaxLineLength()`,
or with fewer `### ` sections than the baseline it is being compared against, or with zero `## `
headings, is not publishable at any `ON_QA_LIMIT`. Today a 48/100 document with 3 headings
where 9 were listed was published silently, and the only thing that noticed was an AI grader
whose opinion the policy is allowed to overrule.

---

## 8. Migration, in slices that can each be tested offline

Each slice must keep `npm test` green, and per gotcha 69 no test may be able to touch the real
series — fixtures only (`test/fixture-series.js`).

1. **Use the audit slice that already exists.** `buildFeedbackTurnPrompt` hands the chapter its
   own `character-voice-validation-<id>.md` (42 KB) instead of the merged report (245 KB).
   No design change. Test: the chunked flow's feedback prompt names the partial file.
2. **Wire the per-chapter carry-forward guard into the feedback stage**, with a same-volume
   baseline so volume 01 is covered. Test: the guard fires on the exact chapter that shrank the
   reference — the glossary flow already has this test; mirror it.
3. **Structural plausibility gate** (§7.2), plus refusing edits that swallow line breaks in a
   heading-structured file.
4. **Delivery-layer dead end**: when `movesAfterFailures` removes a `run` move, open the ticket
   the removal message promises, so `diagnose` is on the menu. Test in
   `test/test-autopilot.js`: a failed step yields a `diagnose` move, not a two-button menu.
5. **Per-character working folder + assembly**, behind a flag, with the published file
   unchanged. Test: assemble → compare against the pre-change file; the loss guard on the
   folder; a relational finding landing in both files.
6. Only after 5 is stable: consider making `pov-map.md` per-chapter blocks.

Slices 1–4 are cheap, independent of the redesign, and each one removes a piece of the failure
that actually happened. Slice 5 is the redesign.

---

## 9. Rough cost estimate (honest about being rough)

What a chapter's repair agent must currently hold: ~230,000 characters.

With per-character files plus its own audit slice: the touched characters' sections
(volume 01: 118,218 chars / 9 sections ≈ 13,000 each; a chapter plausibly touches 4–7 →
50,000–90,000) + its own 42 KB audit page + its 22 KB chapter ≈ **110,000–150,000 characters**
— roughly a 2× cut on the initial load.

The larger saving is not the initial load, it is the thrash: 24 reads and 29 edits on one
unreadable file per chapter, and the 53.7M feedback + 60.3M validation tokens that came from
it. That part cannot be estimated honestly from one volume; it should be measured with
`npm run pipeline-loop` and the prompt audit before and after slice 5.

The structural point stands regardless of the numbers: **the monolith's size grows with every
volume, and it must fit in one model's head. Per-character files do not.**

---

## 10. Open questions for the account owner

1. Is the unit **character** or **character-section (persona)**? The existing guard says
   section. Files suggest character. They are not the same count.
2. Should the working folder be committed with the books, or treated as run state under
   `.run/`? It is the artifact's source of truth, which argues for committing it; it is also
   regenerable, which argues for not.
3. `ON_QA_LIMIT` published a 48/100 volume. Should a cumulative artifact below the passing
   score be publishable at all, given everything downstream is built on it?
4. Volume 01's current reference is damaged and scored 48. It is the base every later volume
   would inherit. Redo it, or start the redesign from a fresh volume 01?

---

## 11. What this proposal does NOT address

- The 13-hour wall clock per volume, which is a throughput problem on this endpoint, not an
  artifact-shape problem.
- The manager menu dead end beyond the one ticket fix in §8.4.
- `pov-map.md`'s whole-file rewrite per chapter (named in §6.4, deferred).
