# Implementation Plan — translation pipeline fixes

Derived from `PIPELINE-REVIEW.md`. Findings are referenced as `R<n>`.

**Design note (R1 withdrawn):** which model serves which role is the configurator's
responsibility, not the code's. Nothing in this plan adds model detection, model identity
checks, or container logic to the task modules. The pipeline keeps treating role endpoints as
opaque and keeps `assertModelServing` as a reachability check only.

Legend: **S** ≈ under an hour · **M** ≈ 1–3 hours · **L** ≈ half a day or more.

## Status — what was built, and what was not

**Done (all with tests, `npm test` green — nine suites):** Phase 0 (0.1–0.6), Phase 1 (1.1–1.7),
Phase 2 (2.1–2.4), Phase 3 (3.1–3.4), 4.1, 4.2, 4.3, 5.2, 6.1, 6.2, 6.3, 6.4. The new suites are
`test/test-task-failure.js`, `test/test-translation-loop.js`, `test/test-disputes.js` and
`test/test-wiki-orchestration.js`; `npm run calibrate` is the live grader measurement.

**Deferred, on purpose — 5.1 (structured artifacts).** It is the largest item in the plan and it
is a rewrite of the four reference pipelines, not a fix: the agents would stop writing
`glossary.md` and start writing JSON deltas that code merges and renders. Two things had to
happen before it was worth doing, and both now have: the correctness gates (publish gate,
ratchet, repairable QA failures) are in place, and the truncation problem it was meant to solve
has already been solved a cheaper way — 5.2's relevance-ordered selection plus 4.3's per-chapter
invalidation removed the "the translator saw volume 1's state" failure without changing the
artifact format. What is still open is the durability half: an agent re-typing a 1,200-entry
cumulative glossary under an output cap, with another agent as the only "no regressions" check.
That is a real risk on a 17-volume series and it is the next thing this plan should take, not
because the gates are wrong but because the artifact format makes them work harder than they
should. It also carries the cost the plan already names: every `contextHash` and rolling-state
file invalidates once.

**Not done — 6.5 (rebuild the epub).** Deliberately last: the deliverable is loose Markdown, and
repackaging it is worth scheduling once the text is trustworthy, not before.

**One deviation from 4.2, recorded honestly.** The plan proposed marking disputed terms inside
`glossary.md` (a `disputed` column) so `parseGlossaryTerms` could downgrade them from law to
advisory. The implementation keeps the dispute OUT of the glossary file and in a queue
(`glossary-disputes.json` at the series root) instead, and the translation stage reads the queue.
Reason: a `disputed` marker inside the glossary makes the glossary agent responsible for the
status of a thing it did not observe, and it lets a disputed term become advisory — which is the
oscillation this item exists to stop. A disputed term stays mandatory for the translator (the fix
happens in the glossary, which is the only stage that can decide) while being named as provisional
in the prompt, in the report, and in the per-chapter invalidation key.

**Three latent bugs found while implementing, two of them invisible to every existing test** (see
AGENTS.md gotchas 49 and 50): `retranslate`'s dry-run branch read a variable declared after it;
`verify-translate`'s commit phase used a settings object the task never defined; and all four
series-root artifact copies chose "the last existing snapshot" with `fileExists`, so a failed
volume's empty file — or the wiki's pre-created scaffold **stub** — was published as the series'
current reference and then audited as one. The first two live only in code a live pass runs, which
no dry run or pure test could reach. The new file-backed tests (`test/test-translation-loop.js`,
`test/test-disputes.js`, `test/test-wiki-orchestration.js`) exist to close that class of blind
spot — the third bug is one of them caught — and `npm run calibrate` measures the grader the whole
system rests on.


---

## Guiding rules for the whole plan

1. **Never lose work silently.** Every failure either fixes itself, quarantines itself with a
   reason, or fails the run. "Logged a warning" is not an acceptable end state for an
   un-monitored run.
2. **The published file must carry its own verdict.** A reader of `translation.md` must be able
   to tell which chapters passed and which did not.
3. **A QA loop may only ever move a chapter forward.** No gate may replace accepted work with
   worse work.
4. **Deterministic checks before model checks.** Anything that can be decided by comparing data
   should not be delegated to a grader.
5. **Every fix lands with a test that would have caught the original bug.**

---

# Phase 0 — Stop shipping broken output (do this first)

Everything in this phase is small, independent, and unblocks the rest.

### 0.1 Fix `jump-in-wiki.js` use-before-declaration — **S** (R6) — ✅ DONE
**File:** `jump-in-wiki.js` (line 586 reads `previousInstallmentNumber`, declared at 617).

Move the previous-volume resolution *above* the prompt-building block:
```js
const isFirst = i === 0;
let previousFolderName = null;
let previousInstallmentNumber = null;
let previousWikiOutputFile = null;
let previousSharedWikiOutputFile = null;
if (!isFirst) { /* resolve folder + installment number + prev file paths */ }

const validatorValues = {
  ...,
  PREVIOUS_INSTALLMENT_NUMBER: previousInstallmentNumber || "(none — this is the first volume)",
};
```
Keep the `ON_MISSING_PREVIOUS` check where it is (it needs the resolved paths).

**Done when:** `npx gulp jump-in-wiki --dry-run` produces a validation prompt dump for both
fixture volumes with the correct prior installment number, and no `[skip]` line appears.

### 0.2 Make the four reference tasks fail when volumes failed — **S** (R5) — ✅ DONE
**Files:** `glossary.js:857`, `character-voice.js:459`, `style-guide.js:481`, `jump-in-wiki.js:833`.

Replace the `console.error` summary with a throw, matching the translation tasks:
```js
if (failedVolumes.length > 0) {
  throw new Error(
    `${failedVolumes.length} of ${volumes.length} volume(s) failed: ${names}. ` +
    `Re-run the task (idempotent) to pick them up.`
  );
}
```
Keep the root-copy step *before* the throw so a partially successful run still publishes the
last good snapshot (that behaviour is deliberate).

**Done when:** a run where every volume fails exits non-zero, and `ON_TASK_ERROR=continue` still
lets the remaining pipeline steps run.

### 0.3 Break the `translate.js` ↔ `verify-translate.js` import cycle — **S** (prerequisite for 0.4/0.5) — ✅ DONE
**Files:** `translate.js`, `verify-translate.js`, `polish.js`, `retranslate.js`.

`verify-translate.js` already imports `chapterArtifactNames` from `translate.js`. Several fixes
below need the reverse import, which Node will resolve to a partially-initialised module.
Move the shared sidecar helpers out of the task modules into `utils/translate.js`:
- `loadVerificationSidecar`, `findingsOf`, `glossaryBlock` (from `verify-translate.js`)
- `chapterArtifactNames`, `STATE_FILE`, `MERGED_FILE` (from `translate.js`)

Task modules re-export them for backward compatibility so existing imports and tests keep working.

**Done when:** `node -e "require('./translate'); require('./verify-translate')"` in either order
resolves every export, and `npm test` passes unchanged.

### 0.4 Publish gate + series-level translation report — **M** (R2) — ✅ DONE
**Files:** `translate.js` (`mergeVolumeTranslationFiles`), new `utils/translation-report.js`,
`gulpfile.js` (optional new `translation-report` step).

1. When merging, read each chapter's verification verdict and record it:
   ```js
   const verdict = verificationVerdict(volumeDir, seg.id);   // { score, pass, verifiedAt } | null
   if (verdict && !verdict.pass) {
     parts.push(`# ${title}\n\n<!-- UNVERIFIED: verification score ${verdict.score}/100 -->\n\n${text}`);
     unverified.push({ id: seg.id, score: verdict.score });
   }
   ```
2. Write `<series root>/translation-report.md` after the translation stage — one row per chapter:
   volume, chapter id, title, deterministic QA, verify score + verdict, retranslate attempts,
   polish drift score, final verdict. Plus a `translation-report.json` sidecar so a later run can
   diff it.
3. The report is the human sign-off surface that the pre-production stage already has
   (`consistency-report.md`) and the translation stage currently lacks.

**Done when:** running the fixture series produces a `translation-report.md` in which
`test_story(1)/whole` is visibly marked FAIL 57/100, and `translation.md` contains the
`UNVERIFIED` marker.

### 0.5 Draft ratchet — a chapter can never end a round worse than it started — **M** (R3) — ✅ DONE
**Files:** `verify-translate.js`, `retranslate.js`, `utils/translate.js`, `translate-qa.js`, `types.js`.

1. Extend the state entry: `bestScore`, `bestDraftHash`, `bestDraftFile`
   (`translation-<id>.best.md`), and a per-chapter `attempts: [{ draftHash, score, at }]` history
   in the verification sidecar.
2. `verify-translate` records the score against the draft it just graded (it already reads the
   previous entry before overwriting it).
3. New pure helper, called by `translate-qa` after every verify batch:
   ```js
   // utils/translate.js
   async function applyDraftRatchet(volumeDir, bundle) {
     // for each chapter: if current draft score < bestScore and the best copy exists,
     // restore translation-<id>.best.md as the draft, reset draftHash, and mark
     // state.chapters[id].noImprovement = true
   }
   ```
4. `qaLoopDecision` gains a fourth stop reason: `"no-improvement"` — a round where nothing got
   better is treated like a stall (cheaper and more truthful than counting rewrites).

**Done when:** a test with a stubbed harness that scores draft A at 75 and draft B at 50 ends
with draft A published, `noImprovement: true`, and the loop stopping on `"no-improvement"`.

### 0.6 Make deterministic-QA failures repairable instead of fatal — **M** (R4) — ✅ DONE
**Files:** `translate.js`, `retranslate.js`, `verify-translate.js`, `utils/translate.js`.

1. **Keep the draft.** On a deterministic-QA hard failure, write it and mark it:
   ```js
   await fs.writeFile(draftPath, draft + "\n");
   state.chapters[seg.id] = {
     sourceHash, contextHash, draftHash: sha256(draft + "\n"),
     qaFailed: true, qaFindings: buildPolishGuardFindings(qa),   // reuse the existing builder
   };
   ```
2. `verify-translate` treats `qaFailed: true` as a known FAIL **without spending a model call**:
   it seeds the sidecar entry with the deterministic findings and `score: null, pass: false`.
3. `retranslate` picks those chapters up like any other FAIL (it currently skips chapters with no
   verification entry).
4. Move the completeness gate to the **end of the task**, after every volume has been attempted:
   ```js
   // translate() — after the volume loop
   if (incompleteVolumes.length > 0) throw new Error(`${n} volume(s) incomplete: ...`);
   ```
   so one bad chapter in volume 2 no longer prevents volumes 3–17 from being translated.
5. `qaLoopDecision` reports `noDraft > 0` as its own stop reason (`"missing-drafts"`) instead of
   collapsing into `"stalled"`.

**Done when:** a stubbed run where one chapter trips the residue check still translates every
other volume, the QA loop retranslates that chapter, and the task fails only at the end if it is
still unresolved.

---

# Phase 1 — Make the QA loop actually improve quality

### 1.1 Acceptance sample floor — no volume accepted on a "reject" grade — **S** (R9) — ✅ DONE
**File:** `configs/shared.js` (`meetsAcceptanceCriteria`), `test/test-config.js`.
```js
const ACCEPTANCE_SAMPLE_FLOOR = (() => {
  const n = parseInt(process.env.ACCEPTANCE_SAMPLE_FLOOR, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : Math.max(0, ACCEPTANCE_PASSING_SCORE - 15);
})();

function meetsAcceptanceCriteria(scores) {
  if (!Array.isArray(scores) || scores.length < ACCEPTANCE_MIN_SAMPLES) return false;
  if (scores.some((s) => s < ACCEPTANCE_SAMPLE_FLOOR)) return false;   // a bad sample cannot be averaged away
  return computeRollingAverage(scores) >= ACCEPTANCE_PASSING_SCORE;
}
```
**Done when:** `[100, 38]` and `[100, 40]` are rejected and `[72, 71]` is accepted, pinned in tests.

### 1.2 Two samples per chapter verification — **M** (R9) — ✅ DONE
**Files:** `verify-translate.js`, `utils/qa-loop.js` (extract the sampling helpers).

Chapter verification currently trusts one score while artifact acceptance uses two samples plus a
temperature-0 anchor. Reuse the same machinery:
- score each chapter twice at `JUDGE_TEMPERATURE`; if the two differ by more than
  `ACCEPTANCE_SCORE_TOLERANCE`, take a third at temperature 0 and use the median;
- store all samples in the sidecar (`samples: [72, 64, 69]`, `score: 69` = median).

Keep it batched: sample 1 for the whole batch, sample 2 for the whole batch — never interleaved
per chapter, so the container-switch cost is unchanged.

**Done when:** a stubbed verifier returning 90 then 40 produces a FAIL, and the report shows all
three samples.

### 1.3 Wire `confirmationCheck` into the four chunked loops — **M** (R9) — ✅ DONE
**Files:** `glossary.js`, `character-voice.js`, `style-guide.js`, `jump-in-wiki.js` (their
`runChunkedQaLoop` implementations).

The chunked fallback — the path large epub volumes take — never passes `confirmationCheck`, so
the biggest volumes get the least rigorous gate. Either route the chunked loops through
`runSharedQaLoop` or pass the same `confirmationCheck` callback they already build for the
whole-installment path.

**Done when:** a chunked-mode test run shows the exceptional-consensus confirmations firing.

### 1.4 Tiebreak may not launder a failing chapter into a pass — **S** (R10) — ✅ DONE
**File:** `verify-translate.js` (`runAuditTiebreak`).
```js
const final = auditScore !== null ? Math.round((verifierScore + auditScore) / 2) : verifierScore;
const newPass = final >= passingScore && !(
  prevPass === false && !(verifierScore >= passingScore - tiebreakBand && auditScore >= passingScore + tiebreakBand)
);
if (prevPass === false && newPass) entry.tiebreakRescue = true;   // visible in the report
```
Keep the existing rule that the auditor's findings win when the auditor is the pessimist.

**Done when:** verifier 65 + auditor 74 stays FAIL at `PASSING_SCORE=69`; verifier 68 + auditor 75
is a PASS marked as a rescue.

### 1.5 Retranslation value filter — **M** (R16) — ✅ DONE
**Files:** `utils/translate.js` (new pure `worthRetranslating`), `retranslate.js`, tests.
```js
function worthRetranslating(entry, passingScore) {
  if (entry.score === null) return true;                       // unparseable: must retry
  if (/\[HIGH\]/.test(entry.findings || "")) return true;      // fidelity/terminology problems
  return entry.score < passingScore - 5;                       // cosmetic-only miss: report, don't rewrite
}
```
Chapters that are skipped by the filter are recorded in the verification report as
`below threshold — cosmetic findings only`, so nothing is silently dropped.

**Done when:** a chapter at 67 with only LOW findings is not retranslated, and the report says why.

### 1.6 Targeted correction instead of whole-chapter rewrite — **L** (R16) — ✅ DONE
**Files:** `retranslate.js`, `utils/translate.js`.

Findings quote short source spans. Use them:
1. Parse each finding's `Source: "..."` quote and locate it in the chapter source.
2. Group findings into the smallest paragraph ranges that cover them.
3. Re-translate only those ranges (with the surrounding translated text as context), then stitch
   them back into the draft.
4. Fall back to the current whole-chapter pass when a finding is structural (no locatable quote)
   or when the targeted pass fails the deterministic QA.

This is the single biggest token saving in the plan: today a chapter with one bad sentence is
translated again from scratch.

**Done when:** a test where a finding quotes one paragraph produces a draft that changed only
that paragraph, and the deterministic QA still passes.

### 1.7 Grader calibration fixture — **M** (supports R9) — ✅ DONE
**Files:** new `test/calibration/`, new `npm run calibrate`.

The whole quality system rests on a number a model produces, and nothing measures whether that
number means anything. Add a small fixture: 5–8 short chapter pairs, each with the source, a
deliberately flawed translation (a known omission, a known meaning flip, a terminology break) and
a clean one, plus the expected band. Run the real verifier over them and print the score
distribution.

**Done when:** `npm run calibrate` reports, per case, the score and band, and a regression in
grader behaviour becomes visible as a changed distribution rather than a mystery in production.

---

# Phase 2 — Cross-chapter and cross-volume consistency

The pipeline's biggest strategic gap: every gate looks at one chapter, but a 17-volume series
fails through drift *between* chapters.

### 2.1 Per-volume consistency pass — **L** (R8) — ✅ DONE
**Files:** new `volume-consistency.js` gulp task (or a phase inside `verify-translate.js`).

One call per volume, batched after the per-chapter verify batch:
```js
messages: [
  { text: mergedVolumeTranslation },          // the whole volume, in reading order
  { text: tailOf(previousVolumeTranslation, 2000) },
  { file: glossaryFile }, { file: styleGuideFile },
  { text: "List every place this volume contradicts itself or the previous volume: " +
          "name/term renderings, tense, register, POV markers, character voice. " +
          "Findings only — do not rewrite. Tag each with the chapter id." },
]
```
Output: `volume-consistency.md` + a sidecar whose findings are chapter-tagged, so the existing
retranslate loop can apply them.

**Done when:** a fixture with two chapters rendering the same term two ways produces a finding
naming both chapters.

### 2.2 Deterministic intra-volume variant scan — **M** (R8) — ✅ DONE
**Files:** `utils/translate.js`, `verify-translate.js` report.

Free, no model: for every glossary term used in the volume, scan the merged translation for
near-variants of the canonical rendering (case differences, hyphenation, singular/plural, a
second rendering of the same source term) and report each as a finding. This catches the most
common drift class without spending a token.

**Done when:** a merged volume containing both "Mirror" and "the Mirror system" for one term is
reported.

### 2.3 Cross-volume continuity — **S** (R8) — ✅ DONE
**Files:** `translate.js`, `retranslate.js`.

`prevChapterTail` resets at every volume boundary. Seed volume N+1's first chapter with the tail
of volume N's published translation (polished text when it won the merge), and label it honestly
in the prompt ("the previous volume ended with").

**Done when:** a two-volume fixture's first chapter prompt contains the previous volume's tail.

### 2.4 Fix the false continuity cue — **S** (R20) — ✅ DONE
**Files:** `translate.js`.

When a chapter fails, the next chapter is currently told "the previous chapter ended with…" using
the last *successful* chapter's tail. Track the id and say which chapter it came from.

---

# Phase 3 — Make a 17-volume run feasible

### 3.1 Batch the audit phases across volumes — **L** (R14) — ✅ DONE
**Files:** `verify-translate.js`, `polish.js`, `utils/hooks.js` (docs only).

Today `withHooks("verify-audit")` sits inside `processVerifyVolume` and
`withHooks("polish-audit")` / `withHooks("polish")` inside `processPolishVolume` — so the
container switch fires once per volume (and per polish round per volume), which is the exact
interleaving the batching was designed to avoid.

Restructure both tasks into volume-wide phases:
```
verify-translate:  phase 1 — verify every volume's chapters        (one endpoint)
                   phase 2 — one tiebreak batch, ALL volumes       (one switch)

polish:            phase A — produce guard-gated candidates for every volume   (one endpoint)
                   phase B — one audit batch over ALL candidates               (one switch)
                   phase C — one re-polish batch over ALL failures             (one switch)
                   repeat B/C per round, still batched across volumes
```
Move the `withHooks(...)` wrappers from the per-volume functions to the task-level phase loops.
Per-chapter state and sidecar writes are already volume-local, so this is a re-ordering, not a
rewrite.

**Done when:** a two-volume run logs exactly one `verify-audit` hook invocation and one
`polish-audit` hook invocation (currently two each), and `hooks/README.md` + AGENTS.md §3 match.

### 3.2 Per-role context window and output cap — **M** (R15) — ✅ DONE
**Files:** `harness.js` (`envMaxTokens`, `runOneShot`), `utils/translate.js` (`roleEndpoint`).

The output cap is derived from the *global* model's context and applied to all four roles.
- `roleEndpoint(prefix)` also resolves `<PREFIX>_CONTEXT_WINDOW` and `<PREFIX>_MAX_TOKENS`.
- `runOneShot` accepts a per-call `maxTokens` override; when absent, derive from the role's
  context window, else the global one.
- Log the resolved pair per stage at task start (the log already prints one global number today).

**Done when:** setting `TRANSLATE_MAX_TOKENS=8192` changes only the translate/retranslate calls,
and the stage-start log shows each role's cap.

### 3.3 Prompt budget with honest trimming — **M** (R15) — ✅ DONE
**Files:** `utils/translate.js` (new `estimateTokens` + `fitPromptBudget`), `translate.js`,
`retranslate.js`, `verify-translate.js`, `polish.js`.

```js
function estimateTokens(text, language) { /* chars × per-script factor: CJK ~1.4, latin ~0.3 */ }

function fitPromptBudget({ sourceText, injected, roleWindow, outputReserve }) {
  // trim in priority order, logging every drop:
  //   voice notes → background → style rules → glossary tail
  // never trim the source text; if the source alone does not fit, shrink TRANSLATE_CHUNK_CHARS
  return { injected, dropped: [{ block, chars }] };
}
```
Every drop is logged and recorded in the chapter's QA row, so "the model never saw the style
rules" is never invisible.

**Done when:** a synthetic oversized chapter produces a logged trim list, and no call exceeds the
role's window estimate.

### 3.4 Run estimate and progress — **S** (R16) — ✅ DONE
**Files:** `translate.js`, `translate-qa.js`, `polish.js`.

Print at task start: volumes, chapters, planned calls for this stage, and — when a previous run's
log exists — measured tokens/second and an estimated wall-clock. Print a running counter per batch
(`chapter 14/380`). An overnight run should be able to answer "is this healthy or stuck?" from the
log alone.

---

# Phase 4 — Make the references reach the translator, and flow backwards

### 4.1 Chapter-relative injection — **L** (R11) — ✅ DONE
**Files:** `utils/translate.js` (`extractStyleRules`, `loadVolumeReferences`,
`selectTermsForChapter`), tests.

Today only the style guide's `## Policy Summary` reaches the translator (measured: 1,045 of 11,551
chars on the fixture), the wiki background is truncated from the head (so the *current-state*
sections are what gets cut at volume 17), and voice notes are the first 4,000 chars (the volume-1
cast).

1. **Style:** inject the Policy Summary *plus* the sections whose patterns actually appear in the
   chapter — deterministic detection (`です/ます`, `「」`, `※`, `……`, ruby, tables), budgeted.
2. **Wiki:** inject the roster + the **tail** (current state, open threads), not the head.
3. **Voice:** select the characters who actually occur in the chapter, reusing the same
   occurrence test `chapterTerminology` already applies to terms.
4. **Terms:** replace `break`-on-budget with "keep taking, skipping lines that don't fit", and log
   `dropped` at *every* call site (verify and polish currently log nothing).

**Done when:** a chapter containing a POV marker and dialogue brackets gets the POV and
punctuation sections injected, and the log states what was dropped and why.

### 4.2 Glossary disputes queue — findings that flow backwards — **L** (R7) — ✅ DONE
**Files:** `verify-translate.js` (structured findings), new `utils/disputes.js`, `glossary.js`,
`utils/translate.js`, `AGENTS.md`.

1. Parse the verifier's "the glossary entry appears wrong" findings into structured data:
   ```js
   entry.disputes = [{ term, canonical, proposed, sourceQuote, translationQuote }];
   ```
2. Aggregate into `<series root>/glossary-disputes.json` + a readable `glossary-disputes.md`.
3. `glossary.js` reads the disputes file as a first-class input on its next run: "these renderings
   were challenged during translation, with these quotes — reconcile them and record the decision".
4. Mark disputed terms in `glossary.md` (a `disputed` column or a `> disputed:` note) so
   `parseGlossaryTerms` can downgrade them from law to advisory.
5. **Stop the oscillation immediately** (this part is small and worth doing before the rest):
   while a term is disputed, the translate/retranslate prompt says *"the glossary rendering for X
   is disputed — keep the canonical form; do not improvise"*, instead of the current instruction
   that orders the translator to break it.

**Done when:** a fixture run where the verifier challenges a term produces a disputes entry, and
the next retranslate round no longer contradicts the next verify round on that term.

### 4.3 Per-chapter invalidation — **M** (R13) — ✅ DONE
**Files:** `utils/translate.js` (`loadVolumeReferences`), `translate.js`, `retranslate.js`,
`polish.js`.

`contextHash` is the hash of six whole reference files, so any reference regeneration invalidates
every chapter of every volume. Add a chapter-scoped key:
```js
const chapterContextHash = sha256([
  ...chapterTerms.map((t) => `${t.term}\u0000${t.rendering}`),
  injectedStyleRules, injectedBackground, injectedVoiceNotes,
].join("\u0000"));
```
Store both hashes; a chapter is up to date when its own `chapterContextHash` matches. Keep the
volume-level hash as the fast "nothing changed at all" path.

**Done when:** a test that changes a glossary term absent from a chapter leaves that chapter's
draft untouched.

---

# Phase 5 — Make the cumulative artifacts durable

The largest refactor; do it after the correctness phases so it can be validated against real runs.

### 5.1 Structured artifacts + deterministic merge — **L** (R12) — ⏸ DEFERRED (see the status note)
**Files:** `glossary.js`, `character-voice.js`, `style-guide.js`, `utils/handoff.js`, new
`utils/artifact-store.js`, `utils/translate.js` (parser becomes a loader).

Today each volume's artifact is produced by an agent re-typing the entire cumulative document
under an output cap, and the only "no regressions" guard is another agent diffing two documents.

1. Machine-owned data lives in JSON: `glossary.json` (`term`, `rendering`, `section`,
   `addedInVolume`, `notes`, `disputed`), `voice.json`, `style-rules.json`.
2. Agents propose **this volume's additions and changes only** — a bounded, checkable output.
3. Code merges deterministically and renders `glossary.md` / `character-voice.md` /
   `style-guide.md` from the JSON (a pure function).
4. "No regressions" becomes a set difference on term keys — a hard error, not an impression.
5. `parseGlossaryTerms` / `extractStyleRules` read the JSON directly; the Markdown becomes a
   human-facing rendering rather than the source of truth.

**Cost to accept:** every existing `contextHash` and rolling-state file is invalidated once — a
one-time full re-verification. Budget for it explicitly.

**Done when:** deleting a term from volume N's JSON produces a hard "regression" error, and the
rendered Markdown is byte-identical across two runs of the same data.

### 5.2 Fix the truncators' recency assumption — **M** (R12) — ✅ DONE
**Files:** `glossary.js` (`truncateGlossary`), `character-voice.js`, `style-guide.js`.

"Drop the oldest rows (document order)" is wrong for a section-organised document: the last
*sections* are kept, not the newest *entries*, so at volume 17 the extractor is shown 200 rows
that exclude the volume-1 cast and duly rediscovers the main characters as new terms. Select by
`addedInVolume` (or by which entries occur in this volume's source) instead.

---

# Phase 6 — Output correctness and edge cases

### 6.1 Correct chapter headings — **M** (R18) — ✅ DONE
**Files:** `utils/source.js` (segment files hold body only), `translate.js`, `retranslate.js`,
`utils/translate.js` (`mergeVolumeTranslation`), `polish.js`.

Currently the segment file contains the source H1, the model translates it inside the body, and
the merge prepends the original heading on top — which for plain-text volumes is the *file name*
(`test_story(1)/translation.md` literally starts `# test_story(1).md`) and for epub volumes is the
untranslated Japanese title.

1. Strip the H1 from the segment body at extraction; keep the title on the segment record.
2. Ask the translator to emit the title on a marked first line; split it off and store it as
   `titleTranslated`.
3. Merge uses `seg.titleTranslated || seg.title`, and the polisher's "no heading" rule then
   matches reality.

**Done when:** the fixture's `translation.md` starts with `# Sora's First Night Shift` and contains
no file name and no duplicated heading.

### 6.2 Empty and near-empty chapters — **M** (R19) — ✅ DONE
**Files:** `utils/source.js`, `utils/translate.js` (`checkTranslationQa`), `translate.js`.

1. Extraction writes `# title` for a chapter whose body converted to nothing and records the title
   length as `chars`. Flag any segment whose body is under a floor (e.g. 200 chars) as
   `empty: true` and report it.
2. `checkTranslationQa` currently skips its length check when the source is empty — make an empty
   source a hard finding.
3. Log spine accounting at extraction: `openEpub` already returns `spine.length`,
   `textItems.length` and `entryCount`; warn when they differ
   (`spine lists 42 items, 38 text sections extracted — 4 skipped: cover, css, …`).
4. Add a lossless check: sum of segment bodies vs the `-whole.md` size.

### 6.3 Small bug fixes — **S each** (R20) — ✅ DONE
| Fix | File |
|---|---|
| `meta.parts.every((p) => fileExists(...))` is never awaited, so a deleted part file is accepted as a cache hit | `utils/source.js:1065` |
| The wiki has no `regeneratedAny` cascade although AGENTS.md claims it | `jump-in-wiki.js` |
| Findings are truncated mid-list while the prompt claims "MUST fix all of them" — drop whole findings and print "showing N of M" | `verify-translate.js`, `retranslate.js`, `utils/translate.js` |
| `retranslate` reads the previous chapter's draft for continuity while that chapter may be retranslating concurrently | `retranslate.js` |
| `types.js` `TranslationStateEntry` omits `retranslateAttempts`, which the stall guard depends on | `types.js` |
| `selectTermsForChapter` logs `dropped` only in `translate.js` | `verify-translate.js`, `polish.js` |
| The series-root copy of a cumulative artifact used `fileExists`, so a failed volume's empty file — or the wiki's pre-created scaffold **stub** — was published as the series' current artifact | `glossary.js`, `character-voice.js`, `style-guide.js`, `jump-in-wiki.js` (found while writing `test/test-wiki-orchestration.js`) |

### 6.4 Reports become inputs — **M** (R17) — ✅ DONE
**Files:** `translate.js`, `consistency-audit.js`, `glossary.js`, `utils/handoff.js`.

1. `translate` reads `consistency-report.md`'s verdict. **Decision needed:** hard gate
   (`FAIL` → refuse, override with `--allow-fail`) or loud warning? Recommended: hard gate, since
   the audit exists precisely as a pre-translation sign-off and an override flag keeps the
   un-monitored path usable.
2. Missing glossary: currently one console warning. Make it explicit — refuse unless
   `--allow-no-glossary`, since terminology consistency is the one thing no later stage can repair.
3. `glossary-coverage.json`'s zero-occurrence list feeds the next glossary run ("these entries
   were never used — reconsider them").
4. `chapters.json` becomes the translation stage's chapter list instead of being re-derived from
   the bundle.

### 6.5 Optional: rebuild the book — **L** — ⏸ NOT DONE (optional, deliberately)
The epub's images and structure are extracted but never reassembled; the deliverable is loose
Markdown. A final `package` step that rebuilds an epub from `translation.md` + `images/` + the
original spine is worth scheduling once the text itself is trustworthy.

---

# Testing plan

| New test | Pins |
|---|---|
| `test/test-wiki-orchestration.js` | the `jump-in-wiki` per-volume body actually executes (would have caught 0.1), plus `ON_MISSING_PREVIOUS` and the root copy |
| `test/test-task-failure.js` | each of the four reference tasks exits non-zero when every volume failed (0.2) |
| `test/test-translation-loop.js` | stubbed-harness end-to-end: translate → verify → retranslate → polish, covering the ratchet (0.5), the quarantine path (0.6), the value filter (1.5) and the publish marker (0.4) |
| `test/test-merge-headings.js` | merged volume uses the translated title, no filename, no duplicate heading (6.1) |
| `test/test-prompt-budget.js` | `estimateTokens` + `fitPromptBudget` trim order and logging (3.3) |
| `test/test-disputes.js` | structured dispute extraction and the "keep the canonical form while disputed" prompt line (4.2) |
| extend `test/test-config.js` | `ACCEPTANCE_SAMPLE_FLOOR` under both default and override (1.1) |
| extend `test/test-translate.js` | `worthRetranslating`, `chapterContextHash`, `applyDraftRatchet`, variant scan (1.5, 2.2, 4.3, 0.5) |
| `test/calibration/` + `npm run calibrate` | grader score distribution against known-good and known-bad translations (1.7) |

---

# Documentation to update as part of this

- **AGENTS.md** — gotcha 21 (the four reference tasks now fail the run), §8.5 (ratchet, quarantine,
  publish gate, batched audit phases, per-role caps), §3.5/§4–§7 (structured artifacts if Phase 5
  lands), a new gotcha for "model selection is the configurator's job; the code only checks
  reachability" so nobody re-adds container logic.
- **hooks/README.md** — the audit hooks now fire once per batch, not per volume.
- **PIPELINE-REVIEW.md** — mark each finding fixed with the commit that fixed it.

---

# Sequencing

```
Phase 0  (≈1 day)   correctness of what gets published — no dependencies
   ↓
Phase 1  (≈2 days)  the QA loop improves rather than churns
   ↓
Phase 3  (≈2 days)  make a 17-volume run finish in a sane amount of time   ← before Phase 2,
   ↓                                                                  so new passes don't add cost
Phase 2  (≈2 days)  cross-chapter consistency
   ↓
Phase 4  (≈3 days)  references reach the translator; findings flow backwards
   ↓
Phase 6  (≈1 day)  output correctness + small bugs   ← can run in parallel with 1–4
   ↓
Phase 5  (≈1 week) structured artifacts (biggest change, one-time re-verification cost)
```

Phase 6.3 (the small bug table) is independent and can be done any time, including now.

---

# Decisions I need from you before starting

1. **Hard or soft gates?** Should `translate` refuse to run when `consistency-report.md` says FAIL
   or when a glossary is missing (with `--allow-fail` / `--allow-no-glossary` overrides), or stay
   warn-only? Recommendation: hard, because both are things no later stage can repair.
2. **Unverified chapters: publish marked, or quarantine?** Publish `translation.md` with an inline
   `UNVERIFIED` marker (a complete book, visibly imperfect) versus keeping failing chapters out of
   the merged file entirely. Recommendation: publish marked — a partial book that looks complete
   is the worse failure.
3. **Phase 5 now or later?** The structured-artifact refactor is the most valuable long-term change
   and the most disruptive: it invalidates every existing state file once. Recommendation: after
   Phases 0–4, validated against a real volume.
4. **Targeted retranslation (1.6)?** It is the largest token saving but also the most delicate
   stitching. Recommendation: yes, but behind a flag (`TRANSLATE_TARGETED_FIX=true`) with the
   whole-chapter pass as the fallback.
