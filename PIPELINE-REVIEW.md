# Translation Pipeline Review — big-picture findings and proposed fixes

Date: 2026-10-01
Scope: the whole pipeline as it serves the project's goal — take a 17-volume light-novel
series and produce a trustworthy English translation, un-monitored, overnight.
Method: read the translation stage (`translate.js`, `verify-translate.js`, `retranslate.js`,
`translate-qa.js`, `polish.js`, `utils/translate.js`), the reference-artifact stage
(`glossary.js`, `character-voice.js`, `style-guide.js`, `jump-in-wiki.js`,
`consistency-audit.js`, `utils/qa-loop.js`), the AI layer (`harness.js`), the source layer
(`utils/source.js`), the wiring (`gulpfile.js`, `utils/hooks.js`, `configs/shared.js`),
the prompts, the tests, and the **actual output of previous runs** in `test-series/`.

Everything below is backed by code at a specific line or by a generated artifact on disk.

---

## Summary table

| # | Finding | Severity | Area | Resolved by |
|---|---|---|---|---|
| 1 | ~~The cross-model quality check cannot be verified on the documented setup~~ — **withdrawn: by design** (see the note under finding 1) | — | Design | — (no code change; role→model mapping stays in the hooks) |
| 2 | A chapter that **fails** verification is polished and published as the final translation | Critical | Workflow | 0.4 — the publish gate (`unverifiedMarker` inside `translation.md`) + `translation-report.md` |
| 3 | The QA loop has no ratchet: a retranslation can replace a good draft with a worse one | Critical | Workflow | 0.5 — `recordBestDraft` / `applyDraftRatchet` + the `no-improvement` stop reason |
| 4 | One chapter that fails the deterministic gate aborts the entire stage, and the QA loop can never fix it | Critical | Workflow | 0.6 — the draft is kept, quarantined to `translation-<id>.rejected.md`, and `verify` seeds the verdict with no model call; completeness asserted at task end |
| 5 | The four reference tasks exit with code 0 even when *every* volume failed | Critical | Guardrail | 0.2 — `volumeFailureError` wired into every task (pinned by `test/test-task-failure.js`) |
| 6 | `jump-in-wiki.js` currently throws on every volume (use-before-declaration) and the failure is swallowed | Critical | Bug | 0.1 — the declaration was hoisted |
| 7 | Nothing flows backwards: a discovered bad glossary entry is sent to the translator, creating a self-contradicting loop | High | Workflow | 4.2 — `utils/disputes.js`: the `GLOSSARY DISPUTE:` block → the series queue → the glossary amend pass (deviation from the plan, recorded in `IMPLEMENTATION-PLAN.md`) |
| 8 | Nothing checks consistency *across* chapters or volumes — the dominant failure mode for a 17-volume series | High | Strategy | 2.1 (the cross-chapter audit, inside the existing `AUDIT_*` batch) + 2.2 (the deterministic rendering-variant scan) + 2.3 (cross-volume continuity) |
| 9 | The chapter gate is weaker than the artifact gate, and the artifact gate accepts a "Reject" grade | High | Guardrail | 1.1 (`ACCEPTANCE_SAMPLE_FLOOR`) + 1.2 (repeat sampling, median) + 1.3 (the exceptional-consensus confirmation in all four chunked loops) + 1.7 (`npm run calibrate`, which measures the grader) |
| 10 | The tiebreak can launder a failing chapter into a pass | High | Guardrail | 1.4 — `bothBelowLine` refuses the flip; a legitimate flip is recorded as `tiebreakRescue` |
| 11 | Only a thin slice of the reference material ever reaches the translator (measured: 9% of the style guide) | High | Strategy | 4.1 + 5.2 — `selectSectionsByRelevance` everywhere the truncation happens; 3.3 — the prompt budget that says out loud what the model did not see |
| 12 | Cumulative artifacts are re-typed by a model every volume instead of merged by code | High | Architecture | **partly** — 5.2 removed the truncation failure this item was meant to prevent; the JSON-store rewrite (5.1) is **deferred**, with the reason recorded |
| 13 | Reference invalidation is all-or-nothing: one glossary fix re-translates the whole series | Medium | Cost | 4.3 — `chapterContextHash` (the glossary rows that chapter actually uses) |
| 14 | Model switching happens **per volume**, not per batch — the opposite of the documented design | High | Feasibility | 3.1 — verify runs four phases with ONE audit batch; polish runs Phase A / audit round / repair round |
| 15 | No prompt/context budget; the output cap is global while the endpoints are per-role | High | Feasibility | 3.2 (per-role `_CONTEXT_WINDOW` / `_MAX_TOKENS`) + 3.3 (`fitPromptBudget`, honest trimming) |
| 16 | No cost or time budget; every failing chapter gets a full re-translation regardless of how close it is | Medium | Feasibility | 1.5 (`worthRetranslating`) + 1.6 (targeted correction — re-translate only the quoted passages) + 3.4 (run estimate + heartbeats) |
| 17 | Reports are write-only: a FAIL verdict changes no control flow anywhere in the pipeline | High | Workflow | 6.4 + 0.4 — `checkTranslationPreconditions` refuses to start `translate` on a FAIL/stale audit or a missing glossary (`--allow-fail` / `--allow-no-glossary` override); the disputes queue makes verification feedback reach the glossary |
| 18 | The published translation's chapter headings are wrong (filename / untranslated source title) | Medium | Output quality | 6.1 — `headingForSegment` (a real declared title only, never a synthetic one, never in the source script) |
| 19 | Empty or near-empty source chapters are invisible to every check | Medium | Edge case | 6.2 — reported at extraction (`bodyChars` / `empty`), skipped without a model call, and "EMPTY IN SOURCE" is a distinct row from "MISSING" |
| 20 | Assorted concrete bugs (un-awaited cache check, missing cascade, false continuity cue) | Medium | Bugs | 6.3 + 2.4 |

**After the fact.** Three latent bugs surfaced while implementing, and the first two are worth
keeping next to the findings they came from (AGENTS.md gotchas 49–50): `retranslate`'s dry-run
branch read a variable declared after it, and `verify-translate`'s commit phase used a settings
object the task never defined — neither was visible to `npm test` or to any `--dry-run`, because
both live only in code a live pass runs. The third: all four series-root artifact copies picked
"the last existing snapshot" with `fileExists`, so a failed volume's stub was published as the
series' living reference. Which is why the file-backed suites (`test/test-translation-loop.js`,
`test/test-disputes.js`, `test/test-wiki-orchestration.js`) stub the model call and run the real
code on real files — and why `npm run calibrate` exists to measure the grader every gate in this
review depends on.

---

# Tier 1 — the pipeline can produce a bad translation and report success

## 1. The cross-model check cannot be verified — **WITHDRAWN, by design**

> **Withdrawal note (2026-10-01).** The owner's intent: choosing which model serves which role is
> the **configurator's** responsibility, not the code's. The code deliberately treats role
> endpoints as opaque and outsources model selection entirely to the hooks. If no switch happens,
> one model does all the work — that is an accepted configuration, not a failure the code should
> detect or prevent. This finding is therefore not a defect and is excluded from
> `IMPLEMENTATION-PLAN.md`. The analysis is kept below as the reasoning that led to the design
> note in the plan ("the code checks reachability only; it must never grow container logic").

**What's wrong.** The entire quality strategy is "a *different* model grades the work". On the
documented machine every container advertises the same model alias (`local`) and shares one
port, so `TRANSLATE_MODEL`, `VERIFY_MODEL`, `EDIT_MODEL` and `AUDIT_MODEL` are all `local`.
The only endpoint check the code runs is:

```js
// harness.js:1892
if (!ids.includes(expected)) { throw new Error(...) }
```

That proves a server is up and lists the string `local`. It does **not** prove the right model
is loaded. If a hook fails, or `hooks/.model-switch-state` names a container that is not
actually serving (AGENTS.md gotcha 22(e) documents this exact hazard), then Hy-MT2 grades its
own translation, the polish auditor grades the polisher's own work, and every score, report
and exit code looks completely normal.

Compounding this: `.env` sets **no** role endpoints, so `AUDIT_*` resolves to the same
`(baseUrl, model)` pair as `VERIFY_*` and `EDIT_*`. On a hosted single-endpoint setup the
"cross-model audit" is one model marking its own homework, and nothing warns about it.

**Why it matters.** This is not a corner case: it is the mechanism the whole design rests on.
A silent model mix-up produces a full 17-volume translation graded by the model that wrote it.

**Fix — not adopted (see the withdrawal note).** The measures below were what a fix would have
looked like; they are recorded only so the design boundary is explicit. None of them is scheduled.
1. Make the serving model *checkable*. Have the machine's hook write a fingerprint after a
   successful switch, and have the task require it:
   ```sh
   # end of hooks/model-switch.sh
   printf '%s\n' "$target_abs" > "$HOOKS_DIR/.model-serving"
   printf '%s\n' "${MODEL_ALIAS:-local}" >> "$HOOKS_DIR/.model-serving"
   printf '%s\n' "$(date -u +%FT%TZ)" >> "$HOOKS_DIR/.model-serving"
   ```
   ```js
   // harness.js — new assertion, called by every translation-stage task
   async function assertRoleServing({ role, endpoint, label }) {
     const fp = await readServingFingerprint();          // hooks/.model-serving
     if (!fp) throw structuralError(`${label}: no serving fingerprint written — the ` +
       `pre-${role} hook did not confirm which container is up.`);
     await assertModelServing({ ...endpoint, label });
     logLine(`[endpoint] ${label}: serving ${fp.dir} (fingerprinted ${fp.at})`);
   }
   ```
2. Add a same-model guard that needs no hooks at all:
   ```js
   // utils/translate.js
   function assertDistinctRoles(a, b, names) {
     if (a.baseUrl === b.baseUrl && a.model === b.model) {
       console.warn(`[translation] ${names[0]} and ${names[1]} resolve to the SAME ` +
         `endpoint (${a.model} @ ${a.baseUrl}) — the cross-check is one model grading ` +
         `its own work. Set ${names[1]}_BASE_URL/_MODEL, or use hooks to switch containers.`);
     }
   }
   ```
   Call it for (VERIFY, AUDIT) in `verify-translate.js:522` and (EDIT, AUDIT) in `polish.js:707`.
3. Record the fingerprint in every sidecar entry, so a report can be audited afterwards for
   "who actually graded this".

## 2. A chapter that fails verification is polished and published

**Evidence (real output, not a hypothesis).** `test-series/test_story(1)/`:

- `translation-verification.json`: `score: 57, pass: false` (tiebreak: verifier 55, auditor 58).
- `translation-verification.md` lists 13 findings, two of them HIGH (a declarative statement
  rendered as a conditional; a character's key line of identification rendered as an address).
- `translation-state.json`: `retranslated: true`, then `polishScore: 80`,
  `polishVerifiedDraftHash === draftHash`.
- `translation.md` — the deliverable — is the **polished text of the 57/100 draft**.

Nothing in the pipeline looks at the verification verdict before publishing. `polish` is
documented to run on "whatever drafts exist (including round-cap FAILs)" (`polish.js`), and its
auditor only asks "did the polish change the meaning?" (`system-prompts/polish-verify.md`:
*"Do NOT re-audit the draft itself: a problem the draft already has is not a finding"*). So a
known-bad chapter is smoothed and shipped, and `polish-qa.md` reports it as
"skipped (up to date)".

**Why it matters.** The final artifact carries no signal about which chapters are trustworthy.
A human picking up `translation.md` cannot tell a 92/100 chapter from a 57/100 one.

**Fix.**
1. Add a publish gate in `translate.js:mergeVolumeTranslationFiles`:
   ```js
   const verdict = verificationVerdict(volumeDir, seg.id);   // from translation-verification.json
   if (verdict && !verdict.pass) {
     // publish, but marked, and never silently
     parts.push(`# ${title}\n\n<!-- UNVERIFIED (score ${verdict.score}) — needs review -->\n\n${text}`);
     unverified.push({ id: seg.id, score: verdict.score });
   }
   ```
2. Write a **series-level** `translation-report.md` (the missing sign-off): one row per chapter
   with verify score, retranslate count, polish drift score, and final verdict — the translation
   equivalent of `consistency-report.md`.
3. Make the polish stage *not* the last source-aware look at a failing chapter: if a chapter's
   verification is FAIL, run the drift audit **and** a fresh verification on the polished text,
   so the published text is the one that was graded.

## 3. No ratchet: the loop can make a translation worse and keep it

**What's wrong.** `retranslate.js:320` overwrites the draft unconditionally:

```js
await fs.writeFile(draftPath, clean + "\n", "utf8");
```

The loop's stop conditions are "all passed", "round limit", "stalled" (`utils/translate.js:787`).
None of them compares the new draft's score with the old draft's score. A chapter that scored 68
gets retranslated from scratch (the old draft is deliberately not shown to the model) and the
replacement scores 52 — the pipeline keeps the 52 and discards the 68. `qaLoopDecision` only
counts *how many* chapters were retranslated, never *whether they improved*.

**Why it matters.** With `TRANSLATE_QA_MAX_ROUNDS=5` a chapter can be rewritten five times and
end up worse than the first draft, with no trace of the better version.

**Fix.** Store the best draft, not the last one:
```js
// state entry additions
bestScore, bestDraftHash, bestDraftFile   // e.g. translation-<id>.best.md
```
In `retranslate.js`, after the next verify batch, compare:
```js
// verify-translate.js, when a sidecar entry replaces a previous score for the same chapter
if (score < prev.bestScore) {
  restoreDraftFromBest(volumeDir, seg.id);   // keep both files, publish the better one
  markChapter(volumeDir, seg.id, "no-improvement");   // counts as stalled for this chapter
}
```
and change `qaLoopDecision`'s "stalled" to "no chapter improved this round", which is the
condition the loop actually cares about.

## 4. One bad chapter aborts the whole stage — and the QA loop cannot fix it

**What's wrong.** Three facts combine:

1. `translate.js:319-324` — a chapter that fails the deterministic gate (residue > 5%, looks
   truncated) is **not written to disk** and gets no state entry.
2. `translate.js:429-438` — the merge then finds a chapter with no text and throws a
   **structural** error.
3. `translate.js:615` — structural errors are never skippable, so the per-volume loop rethrows
   and the task dies **before reaching the remaining volumes**. Same shape in
   `retranslate.js:458` and `polish.js:793`.

Meanwhile the QA loop cannot help: `retranslate.js:178-195` skips any chapter with no draft or
no verification entry, so `translate-qa` runs a verify batch, gets `failed: 0, noDraft: 1`,
runs a retranslate batch that retranslates nothing, and stops with reason `"stalled"`
(`utils/translate.js:796`). The chapter that actually needs work is never worked on. And the
"no drafts at all" warning (`translate-qa.js:132`) only fires when *nothing* has a draft, so a
single missing chapter stalls the loop silently.

**Fix.**
1. Never throw away a failed draft. Write it to a quarantine file and record why:
   ```js
   await fs.writeFile(path.join(volumeDir, `translation-${seg.id}.rejected.md`), draft + "\n");
   state.chapters[seg.id] = { sourceHash, contextHash, draftHash: null,
     qaFailed: true, qaFindings: buildPolishGuardFindings(qa) };
   ```
2. Let the QA loop own those chapters: `verify-translate` should verify a `qaFailed` chapter
   (its deterministic findings become the findings list), and `retranslate` should treat
   `qaFailed: true` as a FAIL it can fix.
3. Move the completeness gate to the **end of the task**, after every volume has been attempted,
   so one bad chapter in volume 2 does not prevent volumes 3-17 from being translated:
   ```js
   // translate() — after the volume loop
   if (incompleteVolumes.length > 0) throw new Error(`${n} volume(s) are incomplete: ...`);
   ```
4. Make `qaLoopDecision` treat `noDraft > 0` as a distinct stop reason (`"missing-drafts"`) with
   an explicit instruction to run `translate`, instead of reporting "stalled".

## 5. Four tasks report success when every volume failed

**What's wrong.** The four reference tasks log failures but never throw:

```js
// glossary.js:857-863 (identical shape at character-voice.js:459, style-guide.js:481, jump-in-wiki.js:833)
if (failedVolumes.length > 0) {
  console.error(`\n${failedVolumes.length} of ${volumes.length} volume(s) failed: ...`);
}
```

The translation tasks *do* throw (`translate.js:632`). AGENTS.md gotcha 21 claims the summary
"still fails the run (non-zero exit)" — for the four reference tasks that is currently false.
With `ON_VOLUME_ERROR=skip` (the committed `.env`), a run in which **every** volume failed exits
0, and the default pipeline marches on into `consistency-audit` → `translate` → `polish`.

**Fix.** One line per task, mirroring the translation tasks:
```js
if (failedVolumes.length > 0) {
  throw new Error(`${failedVolumes.length} of ${volumes.length} volume(s) failed: ${names}. ` +
    `Re-run the task (idempotent) to pick them up.`);
}
```
Add a test that runs a task with a stubbed harness that always throws and asserts a non-zero
result (`test/test-qa-orchestration.js` already has the stubbing pattern).

## 6. `jump-in-wiki.js` is broken today, and finding 5 hides it

**What's wrong.** Line 586 reads a variable declared at line 617, in the same block:

```js
586:  PREVIOUS_INSTALLMENT_NUMBER: previousInstallmentNumber || "(none — this is the first volume)",
...
617:  let previousInstallmentNumber = null;
```

JavaScript refuses to read a `let` before its declaration. Verified with a minimal reproduction:

```
ERROR: ReferenceError Cannot access 'previousInstallmentNumber' before initialization
```

The read sits inside the per-volume `try` (line 541), so **every volume** fails with a
`ReferenceError`, finding 5 turns that into a logged warning, and the task exits 0 after
copying whatever old `shared-wiki.md` it finds. The fixture series confirms the outcome:
`test_story(1)` and `test_story(2)` contain **no `wiki.md`, no `shared-wiki.md`, no
validation report** — the wiki task produces nothing. No test covers this path (there is no
wiki orchestration test).

**Why it matters.** The shared wiki is the story-background layer for translation
(`utils/translate.js:1112`) and one of the four artifacts the consistency audit signs off.
Right now the pipeline translates with `BACKGROUND: "(none provided — run the jump-in-wiki task)"`.

**Fix.** Move the previous-volume resolution above the prompt building:
```js
const isFirst = i === 0;
let previousFolderName = null, previousInstallmentNumber = null;   // declare first
if (!isFirst) { previousFolderName = sortedFolderWithSourceMaterial[i - 1];
                previousInstallmentNumber = volumeByFolder.get(previousFolderName)?.installmentNumber ?? null; }
const validatorValues = { ..., PREVIOUS_INSTALLMENT_NUMBER: previousInstallmentNumber || "(none — this is the first volume)" };
```
Then add `test/test-wiki-orchestration.js` (stubbed harness, real temp files) so a syntax-level
failure in the per-volume body can never again pass `npm test`.

---

# Tier 2 — strategy holes

## 7. Findings flow to the wrong place

**What's wrong.** The verifier is explicitly invited to call out a bad glossary entry:

> `system-prompts/verify-translate.md` — "when the canonical rendering in the [Canonical
> Glossary] is itself demonstrably wrong … record a **MEDIUM** finding that the glossary entry
> appears wrong … **so the glossary can be corrected**."

Nothing consumes it. The only reader of `translation-verification.json` is `retranslate.js:197`,
which injects the whole findings blob into the translator as
*"your translation MUST fix all of them"* (`utils/translate.js:353`). So the translator is
ordered to render the term **differently from `glossary.md`** — and the next round's rule 2
("every glossary term that occurs in the source must use its canonical rendering … any deviation
is a finding") flags it as a terminology error. The two rules fight each other for
`TRANSLATE_QA_MAX_ROUNDS` rounds and the glossary is never touched.

The same one-way street applies to `consistency-report.md`, `glossary-coverage.json` (whose
zero-occurrence list is exactly the "this entry may be wrong" signal) and
`translation-brief.md`: all written, none read (grep confirms no consumer).

**Fix.**
1. Give the verification sidecar a structured field instead of prose:
   ```js
   // verify-translate.js — parse findings into buckets
   entry.disputes = [{ term, canonical, proposed, quote }];   // from the MEDIUM "glossary wrong" findings
   ```
2. Aggregate them at the series root: `glossary-disputes.json` + a readable `glossary-disputes.md`.
3. Feed them into the glossary task as a first-class input (a "these renderings were challenged
   during translation, with these quotes — reconcile them"), and mark the disputed term in
   `glossary.md` so the deterministic QA stops treating it as law.
4. Until a dispute is resolved, tell the translator the opposite of what it currently says:
   *"the glossary entry for X is disputed — keep the canonical rendering; do not improvise."*

## 8. Nothing looks at two chapters together

**What's wrong.** Every translation-stage gate is per chapter: verify scores one chapter
(`verify-translate.js:279`), the drift audit scores one chapter (`polish.js:155`), the
deterministic QA checks one chapter. The only cross-chapter mechanism is a 400-character tail
of the previous chapter fed to the next (`TRANSLATE_CONTINUITY_CHARS`), and it resets at every
volume boundary (`translate.js:186` — `prevChapterTail` starts empty per volume).

For a 17-volume series the dominant failure mode is not a bad sentence inside a chapter; it is
drift *between* chapters: a name that changes, a tense that flips, a character's register that
loosensens, a term that gets a second rendering in volume 9. No stage can see that.

**Fix.** Add a cheap per-volume pass, one call per volume:
```js
// new task: verify-volume-consistency (or a phase inside verify-translate)
messages: [
  { text: mergedTranslation },                       // the whole volume
  { text: previousVolumeTail },                      // last ~2000 chars of the previous volume
  { file: glossaryFile }, { file: styleGuideFile },
  { text: "List every place this volume contradicts itself or the previous volume: " +
          "name renderings, tense, register, POV markers. Findings only, no rewrite." },
]
```
Its findings feed the existing retranslate loop as chapter-tagged corrections. Also seed volume
N+1's first chapter with volume N's tail, and log when a glossary term is rendered two different
ways inside one volume (deterministic, free: scan `translation.md` for the term's variants).

## 9. The chapter gate is weaker than the artifact gate — and the artifact gate has a hole

**Side by side.**

| | Reference-artifact acceptance | Chapter verification |
|---|---|---|
| Samples | 2 (rolling window) | **1** |
| Decision | mean of the window | a single score |
| Deterministic temperature-0 anchor | yes (`utils/qa-loop.js:157`) | no |
| Second model | for scores ≥ 85 | only within ±5 of the threshold |
| Parse contract | JSON `{score,band,note}` | "first integer found" (`parseAcceptanceScore`) |
| Iterates with feedback | yes, up to `QA_MAX_ITERATIONS` | no |
| Grader sees the source text | **no** (`glossary.js` acceptance messages: artifact + validation report only) | yes |

So the *cheaper* gate protects the artifact that every later volume and every chapter inherits,
and its grader is instructed to derive its number from another model's summary
(`system-prompts/glossary-acceptance.md`: "Map it to a score band: Pass → 85–100 …").

**The hole.** The window is a plain mean with no floor on any single sample (the "best" strategy
was removed and nothing replaced it). Verified against the live config (`PASSING_SCORE=69`):

```
[100, 40] → mean 70.0 → ACCEPTED     (40 is the rubric's "Requires revision")
[100, 38] → mean 69.0 → ACCEPTED     (38 is the rubric's "Reject")
[ 85, 53] → mean 69.0 → ACCEPTED
```

A volume can be accepted on a grade that means "reject and regenerate".

Also: the chunked fallback (the path big epub volumes take) never wires `confirmationCheck`
(it appears only at `glossary.js:1640`, `character-voice.js:592`, `style-guide.js:611`,
`jump-in-wiki.js:1350` — all whole-installment), so the largest volumes get the least rigorous
gate.

**Fix.**
1. Add a per-sample floor to `meetsAcceptanceCriteria`:
   ```js
   const ACCEPTANCE_SAMPLE_FLOOR = Math.max(0, ACCEPTANCE_PASSING_SCORE - 15);   // env knob
   function meetsAcceptanceCriteria(scores) {
     if (scores.length < ACCEPTANCE_MIN_SAMPLES) return false;
     if (scores.some((s) => s < ACCEPTANCE_SAMPLE_FLOOR)) return false;   // no laundering
     return computeRollingAverage(scores) >= ACCEPTANCE_PASSING_SCORE;
   }
   ```
2. Give chapter verification the same machinery it already has a template for: two samples per
   chapter (or reuse `runSharedQaLoop`'s confirmation logic), and wire `confirmationCheck` into
   the four chunked loops.
3. Give the acceptance grader the source text (or at least the chapter list + the new-terms
   snapshot), so it judges the artifact rather than re-encoding the validator's verdict.

## 10. The tiebreak can pass a chapter the primary verifier failed

**What's wrong.** `verify-translate.js:214`:

```js
const final = auditScore !== null ? Math.round((verifierScore + auditScore) / 2) : verifierScore;
```

A chapter scored 65 ("Requires revision") and re-scored 74 by the auditor averages to 70 → PASS.
It is never retranslated, and `tiebreakApplied: true` means it never gets another second opinion
(`verify-translate.js:162`). The tiebreak was designed as a *second opinion on borderline cases*;
as written it is a veto in favour of passing.

**Fix.** Make averaging decide *how confident* the verdict is, not *whether* the chapter passes:
```js
const final = Math.round((verifierScore + auditScore) / 2);
// Rescue only when the primary verifier was not firmly negative AND the auditor is clearly good.
const rescued = prevFail && newPass && verifierScore >= passingScore - tiebreakBand
                                      && auditScore >= passingScore + tiebreakBand;
if (rescued) entry.tiebreakRescue = true;   // reported, and re-checked by the volume pass
```
and keep the pessimist rule that already exists (auditor's findings win when the auditor drags
the chapter down) for the fail direction.

## 11. The reference material that reaches the translator is a thin slice

**Measured on the fixture.** `extractStyleRules` (`utils/translate.js:290`) returns **only** the
`## Policy Summary` section:

```
injected chars: 1045 of 11551     (9%)
```

Everything else in the guide — the per-construct tables with their exceptions and quoted examples
(`## Address & Honorifics`, `## Pronouns`, `## Punctuation & Formatting`, `## Open Questions`),
which is precisely what the style-guide validator is told to demand — never reaches the
translator, the verifier, the polisher or the drift auditor. If the heading is missing, the
fallback takes the **first 8000 characters** of a cumulative guide — i.e. the oldest rules from
volume 1.

Same shape elsewhere:
- `background` truncates from the top: shared wiki 8000, volume wiki 6000, POV map 2000
  (`utils/translate.js:1112-1120`). At volume 17 the head is the series overview and the earliest
  timeline; the *current-state* sections (roster tail, world state, open threads) are what gets
  cut — while `system-prompts/verify-translate.md` tells the grader to use the background "as a
  condensed checklist".
- `voiceNotes` = the **first** 4000 chars of the cumulative voice reference (`utils/translate.js:1122`)
  = the volume-1 cast, used by the polisher for "keep character voices consistent".
- `selectTermsForChapter` `break`s at the budget (`utils/translate.js:270-275`), so an
  over-budget chapter loses the tail of its applicable terms — and `verify-translate.js:322` and
  `polish.js:224` never log the drop, so a grader can mark a chapter down for a term it was
  never shown.

**Fix.** Make injection chapter-relative rather than document-relative:
1. Style: inject the Policy Summary **plus** the sections whose category matches what the chapter
   actually contains (cheap deterministic detection: scan the chapter for the section's source
   patterns — `です/ます`, `「」`, `※`, `……`), budgeted.
2. Wiki: inject the **tail** (current state) plus the character roster, not the head.
3. Voice: select the characters who actually appear in the chapter (the same occurrence test
   `chapterTerminology` already uses for terms).
4. Terminology: replace `break` with "keep taking while within budget, skipping lines that don't
   fit", and log `dropped` at every call site, not just in `translate.js:200`.

## 12. Cumulative artifacts are re-typed by a model, not merged by code

**What's wrong.** There is no merge, diff or database. Each volume's artifact is produced by an
agent being told to re-emit the whole cumulative document:

> `system-prompts/glossary.md` — "**Carry forward every existing term unchanged.** … Do not
> reword, re-render, or drop any existing entry"

By volume 17 that means: page-read a ~100 KB cumulative glossary, read the whole volume-17 source,
and write the entire merged document back in one `writeFile` under a 65,536-token output cap. The
only guard against a lost entry is another model diffing two documents
(`system-prompts/glossary-validator.md`: "every term from the previous glossary is still present")
— while the same prompt admits "You **cannot** verify carried-forward rules against the earlier
volumes' sources (you do not have them)". The deterministic coverage audit iterates the terms
*currently in* the glossary, so a dropped term produces no row at all: it detects unused entries,
never missing ones.

Worse, the truncators assume document order equals recency:

```js
// glossary.js:194 — "Drop the OLDEST term rows (document order) and keep the newest window"
```

but the glossary is **section-organised** (`## Characters`, `## Places`, `## Items`, …), so the
"newest window" is the last *sections*, not the newest *entries*. At volume 17 the extractor is
shown 200 rows that exclude the volume-1 cast, is asked to find "every term not already in the
previous glossary", and duly rediscovers the main characters as new terms with fresh renderings.

**Fix.** Split data from prose:
1. Keep the machine-owned layer as JSON: `glossary.json` (`{term, rendering, section, addedInVolume,
   notes, disputed}`), `voice.json`, `style-rules.json`. Agents propose **this volume's additions
   and changes only**; code merges them deterministically.
2. Render `glossary.md` from the JSON on every run (a pure function, already half-written in
   `utils/handoff.js`'s table renderers).
3. Make "no regressions" deterministic: a set difference on term keys between volume N-1 and N,
   reported as a hard error — not an LLM's impression.
4. Fix the truncator to select by `addedInVolume` (or by which terms occur in this volume's
   source), not by document position.

## 13. Invalidation is all-or-nothing

**What's wrong.** `contextHash` is the sha256 of the six full reference files
(`utils/translate.js:1130`). Regenerating any artifact invalidates every chapter of every volume.
Combined with the cumulative cascade (`regeneratedAny`), one late glossary correction means:
rebuild volumes N..17's glossary, then re-verify and re-translate every chapter of volumes 1..17.

**Fix.** Invalidate per chapter, on what that chapter actually consumed:
```js
const chapterContextHash = sha256([
  ...chapterTerms.map(t => `${t.term}\u0000${t.rendering}`),   // the terms injected here
  injectedStyleRules, injectedBackground, injectedVoiceNotes,   // the exact slices used
].join("\u0000"));
```
A reference change that does not touch a chapter leaves its draft alone. (Keep the volume-level
hash as a fast path for "nothing changed".)

---

# Tier 3 — feasibility and operability

## 14. Model switching happens per volume, not per batch

**What's wrong.** The design says "one endpoint switch for the whole batch, never interleaved
with the verify loop". The code puts the hook *inside the per-volume function*:

```js
// verify-translate.js:391 — inside processVerifyVolume, which the task calls once per volume
const tiebreakPhase = withHooks("verify-audit", () => runAuditTiebreak({ ... }));

// polish.js:557 and :621 — inside processPolishVolume, once per volume, inside the audit-round loop
const auditPhase   = withHooks("polish-audit", () => runAuditBatch({ ... }));
const rePolishPhase = withHooks("polish",      () => runRePolish({ ... }));
```

On this machine a switch means `docker stop` + start + poll `/health` for up to **900 s**
(`hooks/model-switch.sh`, `MODEL_SWITCH_TIMEOUT=900`) to load a 27B/30B model. For 17 volumes:

- verify batch: up to 17 × (switch to verifier → switch to auditor → switch back) ≈ 34 switches
- polish: 17 volumes × up to 3 audit rounds × 2 switches ≈ 102 switches

That is potentially **many hours of pure model loading**, and it is the exact interleaving the
batching was invented to avoid.

**Fix.** Restructure both tasks into phases across all volumes:
```
verify-translate:   for each volume → verify chapters (one endpoint)
                    then            → one tiebreak batch for ALL volumes (one switch)
polish:             for each volume → Phase A candidates (one endpoint)
                    then            → one audit batch for ALL candidates (one switch)
                    then            → one re-polish batch for ALL failures (one switch)
```
Move `withHooks("verify-audit" | "polish-audit" | "polish")` from the per-volume functions to the
task-level phase loops. The per-chapter state/sidecar logic is already volume-local, so this is a
re-ordering, not a rewrite.

## 15. No prompt or context budget, and the output cap is global

**What's wrong.**
- `envMaxTokens()` (`harness.js:621`) derives one number from `AI_CONTEXT_WINDOW` — the *global*
  model's window — and applies it to **every** role endpoint. There is no `TRANSLATE_MAX_TOKENS`
  or `TRANSLATE_CONTEXT_WINDOW`. Hy-MT2, Qwen-flash and Qwen-27b have different windows, but they
  all get 65,536 output tokens. AGENTS.md gotcha 36 solved this for one model, not for the four.
- There is no token estimation anywhere in `harness.js`: no check that a prompt fits, no trimming,
  no reduction of `max_tokens` when the prompt is large. A too-large prompt is simply sent.
- A single translate call can carry: 24,000 chars of source (`TRANSLATE_CHUNK_CHARS`) + 12,000
  chars of glossary + 8,000 chars of style rules + 16,000 chars of background
  (`TRANSLATION_GLOSSARY_MAX_CHARS` 12000, style fallback 8000, background 8000+6000+2000).
  For Japanese, characters are not tokens — this is comfortably over what a 30B translation model
  is typically served.

**Fix.**
1. Per-role limits: `<ROLE>_CONTEXT_WINDOW` and `<ROLE>_MAX_TOKENS`, resolved in `roleEndpoint()`
   and passed to `runOneShot` as `maxTokens`/`contextWindow` overrides.
2. A cheap pre-call budget in `utils/translate.js`:
   ```js
   function fitPrompt({ sourceText, parts, budget }) {
     const est = Math.ceil((sourceText.length + parts.reduce((a,p)=>a+p.length,0)) * 1.4);
     if (est <= budget) return parts;
     // trim in priority order: voice notes → background → style rules → glossary tail
     ...
     logLine(`[prompt-budget] trimmed ${dropped} chars to fit ${budget} est. tokens`);
   }
   ```
3. Make `TRANSLATE_CHUNK_CHARS` derive from the role's context window rather than being a fixed
   character count, and log the estimated prompt size for every call (the log already has real
   usage numbers after the fact — the point is to know before).

## 16. No cost or time budget

**What's wrong.** Default concurrency 1, `TRANSLATE_QA_MAX_ROUNDS=5`, `POLISH_QA_MAX_ROUNDS=3`,
17 volumes × roughly 20-30 chapters. Every FAIL chapter, whether it scored 69 with three LOW
findings or 20 with a wall of HIGH findings, gets a complete from-scratch re-translation of the
whole chapter (`retranslate.js:232` re-splits and re-translates every part). There is no estimate
printed at the start and no rule that says "this chapter is not worth another full pass".

**Fix.**
1. Print an estimate at task start: chapters × (1 translate + N verify + N retranslate) with the
   measured tok/s from the last run's log.
2. Add a value filter to the loop:
   ```js
   // utils/translate.js
   function worthRetranslating(entry) {
     if (entry.score === null) return true;                       // unparseable = must retry
     if (hasHighFinding(entry.findings)) return true;
     return entry.score < PASSING_SCORE - 5;                      // cosmetic-only misses: report, don't rewrite
   }
   ```
3. Target the correction: when findings quote specific source spans, retranslate only those spans
   and stitch them back, instead of re-translating the whole chapter. Keep the full-chapter pass
   as the fallback for structural findings.

## 17. Reports are write-only; a FAIL gates nothing

**What's wrong.** `consistency-audit.js:331-343` parses the verdict, prints it, and returns
normally. Grep confirms nothing reads `consistency-report.md` except a pointer line in the
handoff brief. `system-prompts/consistency-audit.md` says HIGH findings "block translation" — no
code enforces that, and the default pipeline runs `translate` immediately after. Likewise
`chapters.json`, `translation-brief.md` (whose struck-through missing-file list *is* a
completeness check), and `glossary-coverage.json` are produced and read by nothing.

And `translate` has no prerequisites at all: a missing glossary is one console warning
(`utils/translate.js:1086`); a missing style guide / wiki / voice reference becomes a placeholder
string in the prompt (`verify-translate.js:198`). The fixture series proves it —
`test_story(1)` has `translation.md`, `translation-verification.md` and `polish-qa.md` but **no
glossary, no wiki, no shared-wiki, no character-voice**.

**Fix.**
1. Make the audit a gate with an explicit override:
   ```js
   // translate()
   const verdict = readConsistencyVerdict(seriesDir);
   if (verdict === "FAIL" && !process.argv.includes("--allow-fail")) {
     throw structuralError(`consistency-report.md verdict is FAIL — fix the flagged artifact ` +
       `(or pass --allow-fail to translate anyway).`);
   }
   if (verdict === null) console.warn(`[translate] no consistency report — running without the sign-off.`);
   ```
2. Require the terminology source, or make the degradation explicit and loud:
   `--allow-no-glossary` instead of a warning that scrolls past in an overnight run.
3. Make the handoff artifacts inputs: `chapters.json` as the translation stage's chapter list
   (it already re-derives it from the bundle), `glossary-coverage.json` as the glossary task's
   "these entries were never used — reconsider them" input, `translation-brief.md`'s struck-through
   list as the completeness gate.

## 18. The published translation's chapter headings are wrong

**Evidence.** `test_story(1)/translation.md` begins:

```
# test_story(1).md

The Wakaba Technical Research Institute, ...
```

The heading is the **file name**, and the translated chapter title (`**Sora's First Night Shift**`,
visible in `translation-whole.md`) is gone — the polisher dropped it, as its prompt instructs
("no chapter heading (the heading is added by the pipeline)"). Two defects compound:

1. `mergeVolumeTranslation` (`utils/translate.js:670`) uses `seg.title`, which for a plain-text
   volume is the file name (`utils/source.js:1143`) and for an epub volume is the **source-language**
   title (`utils/source.js:978`). So a real volume publishes `# 第一章 出会い`.
2. The chapter file handed to the translator *already contains* that H1 (`utils/source.js:978`),
   so the model translates the heading inside the body — and the merge prepends the original one
   on top. Result: a duplicated heading, one of them untranslated.

**Fix.** Separate the title from the body once, at extraction:
```js
// utils/source.js — segment files hold body only; the title lives on the segment record
segments.push({ id, file, title, titleTranslated: null, chars });
```
```js
// translate.js — translate the title with the same call, on a marked first line, then split it off
const [titleLine, ...rest] = draft.split("\n");
state.chapters[seg.id].titleTranslated = stripMarkdownFence(titleLine);
```
and have `mergeVolumeTranslation` use `seg.titleTranslated || seg.title`. If a title is not to be
translated (a proper noun), record that decision in the style guide rather than leaving it to
chance.

## 19. Empty chapters are invisible

**What's wrong.** Extraction writes `# <title>\n` for a chapter whose body converted to nothing
(`utils/source.js:978`) and records `chars` as the title's length. Nothing flags it. Downstream,
`checkTranslationQa` skips its length check entirely when the source is empty
(`utils/translate.js:588`: `if (src.length > 0 && …)`), so a title-only "chapter" is translated,
verified and merged without a single warning. The spine also silently drops non-HTML items and
itemrefs missing from the manifest (`utils/source.js:606`, `:617-619`) with no count, so a book
that lost sections looks fine.

**Fix.**
1. In `resolveSourceBundle`, report any segment whose body is under a floor (e.g. 200 chars) as a
   warning with the section name, and record `empty: true` on the segment so the translation stage
   skips it *explicitly* rather than translating a heading.
2. Log the spine accounting on extraction: `openEpub` already returns `spine.length`,
   `textItems.length`, `entryCount` — compare them and warn when they differ:
   `[source] spine lists 42 items, 38 readable text sections extracted (4 skipped: cover, css, …)`.
3. Add a lossless check: `sum(segment body chars)` vs the `-whole.md` char count, and a floor
   relative to the epub's declared text size.

## 20. Assorted concrete bugs

| Bug | Where | Fix |
|---|---|---|
| Cache validation never awaits the file check, so a deleted part file is accepted as a cache hit | `utils/source.js:1065` — `meta.parts.every((p) => fileExists(...))` returns Promises, which are always truthy | `for (const p of meta.parts) if (!(await fileExists(...))) { meta = null; break; }` |
| The wiki has no `regeneratedAny` cascade, though AGENTS.md states it does | `jump-in-wiki.js` (0 occurrences; glossary/voice/style each have 3) | Add the cascade, or correct the doc |
| When a chapter fails, the *previous good* chapter's tail is presented to the next chapter as "the previous chapter ended with…" | `translate.js:186`, `:342` | Track `lastTranslatedSegId` and say "the last translated chapter (chN) ended with" |
| Chapter-wide findings are injected into **every** part of a split chapter, so part 1 is told to fix something that lives in part 2 | `retranslate.js:270-277` | Tag findings with the part whose source contains the quoted span; inject only matching parts |
| `retranslate` reads the previous chapter's draft for continuity while that chapter may be retranslating concurrently | `retranslate.js:267` + `runWithConcurrency` | Force serial order for the continuity read, or disable the cross-chapter tail when concurrency > 1 |
| Findings are truncated (6000 → 3000 chars) while the prompt claims "MUST fix all of them" | `verify-translate.js:73`, `retranslate.js:89`, `utils/translate.js:353` | Count findings, drop whole findings (never mid-finding), and state "showing N of M" |
| `types.js` `TranslationStateEntry` does not document `retranslateAttempts`, which the stall guard depends on | `types.js:323-336` | Add the property |
| The merged volume is Markdown only; the epub's images and structure are extracted but never reassembled | `utils/source.js` (images), no output stage | Add a final `package` step that rebuilds an epub from `translation.md` + `images/` |

---

# Suggested order of work

**Do first (correctness of the deliverable):**
1. Fix `jump-in-wiki.js` (#6) and make the four reference tasks fail loudly (#5). Without these
   the pipeline can silently skip the story-background layer entirely.
2. Add the publish gate + series-level `translation-report.md` (#2) so a published chapter always
   carries its verification verdict.
3. Add the draft ratchet (#3) so the QA loop cannot regress a chapter.
4. Rework the failure path for deterministic-QA chapters (#4) so a bad chapter is repairable
   instead of fatal.

**Then (make the quality mechanism real):**
5. Acceptance floor + chapter verification samples (#9, #10).
6. Cross-chapter consistency pass (#8).

**Then (make a 17-volume run feasible):**
8. Batch the audit phases across volumes (#14).
9. Per-role context/max-token budgets and prompt fitting (#15).
10. Retranslation value filter + targeted correction (#16).

**Then (make the artifacts durable):**
11. Structured artifact storage + deterministic merge (#12), chapter-relative injection (#11),
    per-chapter invalidation (#13), and the findings-back-to-glossary loop (#7).

**Test coverage that is missing and would have caught several of these:**
- a wiki orchestration test (#6),
- a "every volume failed → task exits non-zero" test (#5),
- a translate→verify→retranslate→polish end-to-end test with a stubbed harness that produces a
  deliberately failing chapter (#2, #3, #4),
- a heading test on `mergeVolumeTranslation` (#18),
- a cache-invalidation test for the plain-text parts path (#20).
