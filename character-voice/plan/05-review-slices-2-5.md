# Review of slices 2–5 — verdict, corrections, and answers

**Written 2026-10-10 by the reviewing agent, against the working tree as delivered.**
Read alongside [`04-implementation-plan.md`](04-implementation-plan.md) (the plan of record).

---

## 1. Verdict

**Slices 2, 3 and 5 are done and hold up under independent checking. Slice 4 is done on the
fixture and NOT done against the real corpus** — by its own "done when" line, which says the
rendered file must diff clean against the file on disk. The gap is now identified, and most of it
is fixable.

Nothing was committed. The real corpus was not written to (verified: no `series.db` anywhere under
`/mnt/windows/weeb/oresuki`). No prompt, agent tool list, `.env`, or `hooks/` file was touched
(verified against `git status`). No environment knob was added to any guard (verified: zero
`process.env` reads under `utils/reference-store/`).

Independently re-verified, not taken from the report:

| claim | check |
|---|---|
| 4,245 lines in 15 files, 1,687 lines of tests | `wc -l` matches the report exactly |
| ownership is enforced inside the statement | `facts.js:549` and `facts.js:627` both carry `AND owner_volume = ? AND owner_stage = ? AND sealed = 0` |
| the owner is stamped by the harness, not the caller | `facts.js:423–426` writes `ctx.scope.stage` / `ctx.scope.volume`; `HARNESS_OWNED_FIELDS` (`facts.js:75`) refuses a proposal that tries to carry them |
| the HIGH findings are real post-mortem findings | `integrity.js:22` and `copy-forward.js:30` import `finding` from `../postmortem`, not a lookalike |
| the path follows `SERIES_LOCATION` at call time and refuses instead of guessing | `paths.js` + `test/test-reference-store.js:111–138`, which pins the default *and* asserts an outright refusal when the setting is unset — gotcha 94 satisfied |
| the row caps are the design's caps | `queries.js:21–26` = 40 / 60 / 30, matching doc 03 §3.1, and `resolveLimit` refuses to exceed the default except through the escalation path, which is deliberately not implemented yet |
| `aspect` is a closed vocabulary, enforced | `schema.js:43` + `facts.js:185–189` |
| the banned-path extension strengthens rather than weakens the table | `utils/patches/rules.js` diff: `reference-store` added to `constraint-tables`, its four suites **and the fixture** added to `constraint-tests` — the fixture is listed because it is what keeps those suites pointed at a toy series instead of the books (gotcha 69) |
| the real volume-01 import numbers | re-run independently: **87 glossary rows → 69 imported, 18 refused**; voice bullets **15 imported, 7 refused**. Matches the report |

The implementer also found and fixed a bug in its own code and wrote it down as **gotcha 95**,
including the uncomfortable one: `challengeFact` opened with `typeof proposal && proposal.reason ===
"string"`, comparing a value to the word `"string"`, so every challenge was refused no matter how
well argued. Nothing looked broken — the guard was fail-closed and politely worded. That is gotcha
67's lesson with the polarity flipped: **a check that can never pass is not a check either.**
Finding that about your own work is the behaviour this repo should be rewarding, and it is why the
rest of this review was conducted in the same direction.

---

## 2. Course corrections

### 2.1 A comment describes the approach the code deliberately rejected — fix it

`utils/reference-store/db.js:17–19` says `copyDatabase` "uses the engine's own online-backup call
rather than copying a file that may have a live write-ahead log beside it."

The code does the opposite, and gotcha 95 explains why: `backup()` produced an **empty** destination
whenever the source had a live write-ahead log, which is exactly the state a real copy runs in. The
implementation is `PRAGMA wal_checkpoint(TRUNCATE)` → `copyFileSync` → delete the destination's
`-wal`/`-shm` (`db.js:165–175`).

This is the most dangerous kind of stale comment: it tells the next reader to do the one thing a
test exists to prevent. Fix the header to describe what the code does and why.

### 2.2 The report's description of the damaged volume-01 file understates the damage

The report describes volume 01's `character-voice.md` as "107 lines, its longest line 54,341
characters." Measured directly: **106 lines, longest line 157,566 characters.**

The import numbers are right; the description of the input is not. It matters because that number is
the headline evidence for the whole plan, and it is quoted in `04-implementation-plan.md` §2.
Re-measure and correct the record.

### 2.3 `notes` in the aspect vocabulary is the escape hatch the design warns about

`schema.js:43–56` includes `notes` in `FACT_ASPECTS`. It exists because the voice adapter needs
somewhere to put a bullet whose label it did not recognise (`UNKNOWN_VOICE_LABEL_ASPECT`) — a real
need, wrong name. Doc 03 risk 5 is exactly this: *"`aspect` must be a closed vocabulary or the store
degrades into a pile of notes nobody can query."*

Rename it to `unclassified` and add an integrity query that **counts** unclassified facts per volume,
so the catch-all is visible in the post-mortem instead of comfortable. Keeping a fallback is fine;
hiding it is not.

### 2.4 `challengeFact`'s status update has no ownership predicate — that is correct, and it should say so

`facts.js:740` runs `UPDATE facts SET status = 'disputed' … WHERE id = ?` against a row this store
does not own. That is the sanctioned effect of a challenge — you may not edit another volume's claim,
but you may flag it — and it only touches `status`. But an unconditional `UPDATE` inside a layer
whose whole argument is that its rules live in the `WHERE` clause needs a comment saying *why this
one is deliberately unguarded*, or the next reader will "fix" it and break the challenge verb.

### 2.5 Import and re-verification must use the same matching rule

`evidence.js:40–42` — `normalizeQuote` strips whitespace only. Whatever matching rule is adopted for
§3.1 below must be applied **identically** by `verifyStoredEvidence`, or every furiganed row becomes
a HIGH finding the moment the store is re-audited. Symmetry is the requirement, not the specific rule.

---

## 3. Answers to the six open questions

### 3.1 Should the evidence check reuse the kanji-skeleton comparison? — **Yes**

Without it, 17% of a real volume's glossary rows — including every main character's name — are
refused as unverifiable, because the book prints 如月**きさらぎ**雨**あま**露**つゆ** and the glossary
row says 如月雨露. Neither contains the other.

This problem already has a working answer in this repository: the Han-character skeleton comparison
in `glossary/carry-forward/table.js:130–158`. **Reuse that helper. Do not write a second matching
rule.** Three conditions:

1. **Carry its length guard over.** That file states that a two-kanji skeleton is "two common kanji
   sitting next to each other, which happens all over a real page." A skeleton match on a short term
   is coincidence, and coincidence is not evidence.
2. **Record which rule matched.** Store `matched: "verbatim" | "skeleton"` on the evidence item. An
   auditor must be able to tell "the book prints this string" from "the book prints these characters
   in this order."
3. **Apply it symmetrically** (§2.5). Import and re-verification use the same rule, or the store
   reports itself as corrupt on the second look.

### 3.2 Who seals a volume, and at which step? — **Code, at the end of that volume's pre-production**

Sealing is not an agent action and gets no tool in slice 7. It is the last thing the pipeline does
for a volume, immediately after the rendered artifacts are written and before the acceptance test
reports.

The gap the implementer spotted is real: a row carried forward from volume 3 sits **unsealed** in
volume 5's file, so a snapshot can contain rows that are still editable by their own volume. Close
it with an integrity query rather than a new mechanism:

> **A store may not be copied forward unless every volume ≤ N represented in it is sealed.**

That is the invariant the whole chain depends on, and it is checkable in one query. Copy-forward
already refuses on integrity failure; this is one more finding in the same list.

### 3.3 Should a sealed volume's cast be frozen too? — **Yes**

A cast merge deletes a `cast` row and rewrites the keys on other rows' claims. It is the one
operation in the layer that can make a whole set of published facts quietly disappear, and it is
currently allowed after sealing.

After sealing: **allow alias linking** (non-destructive — a spelling, not a duplicate entry), and
**refuse a merge that would delete a cast entry whose facts are sealed.** Express the merge as
supersession instead: the old entry stays, marked merged-into, the facts are re-pointed, and the
re-pointing is recorded. Same outcome, no vanishing.

### 3.4 Document-level text has no home in the schema — **Give it one, and fix the headers**

Two separate defects, both part of why slice 4 does not diff clean on the real corpus:

- The real glossary's title line and its two style-policy paragraphs are parsed and then dropped.
  Add a small ordered table for document prose (title, preamble paragraphs, per document), rendered
  back verbatim. The voice adapter already collects a `preamble` and does not render it — same fix.
- The column headers differ: the real file uses `Japanese | English | Notes`, the renderer emits
  `Term | Rendering | Notes`. This is not cosmetic. `utils/delivery-verify/signals.js` counts
  `glossaryHeadTerms` and `glossarySections`, and `parseGlossaryTerms` reads the file back. The
  renderer must emit the headers the rest of the pipeline already reads.

Slice 4's "diffs clean" criterion is met on the fixture and **not** met on volume 01 (15,261 →
11,118 characters for the glossary). These two fixes are the fixable part. The rest of that gap is
the damaged voice file, which is not recoverable and should not be.

### 3.5 A challenge always supersedes — **Make supersession a choice, not a side effect**

`facts.js:736` hardcodes `supersedes: target.id`, so challenging a fact always replaces it, and
there is no way to say "this is contested, keep the old row live until we know."

Change it to:

- `challenge_fact(id, {reason, evidence, supersede: false})` — the default. Inserts the challenger
  with `supersedes: null`, marks the target `disputed`. The translator sees a contested claim, which
  is what the existing glossary dispute queue already does and what the precedent supports.
- `supersede: true` — the current behaviour, for when the argument is decisive.
- `resolve_challenge(id, outcome)` — `uphold` retracts the challenger and clears the target's
  `disputed`; `accept` sets `supersedes` and marks the target `superseded`.

A challenge that cannot be closed is a permanent warning nobody can clear, and the pipeline already
has a signal for open disputes — it should be able to reach zero.

### 3.6 Rows the book never prints — **Add a second kind of evidence, not an exemption**

Four of the 18 refused rows are legitimate glossary content that the book never prints verbatim: a
mock-heroic nickname set, an attack name, a first-person-note row (僕／俺), a catchphrase.

Do **not** add a "no evidence needed" path — that is the hole the whole design exists to close.
Instead, recognise that these rows make a different claim, and let the evidence say which:

| kind | what it asserts | what it must cite |
|---|---|---|
| `quote` | the book prints this string | a line where the string occurs (verbatim or skeleton, §3.1) |
| `governs` | this row is the decision made about a passage that **is** in the book | a real `volume:chapter:line` whose text the row is about |

Both are checkable by code. Only the first claims "the book prints this," and the distinction is
stored rather than assumed. The 僕／俺 row governs pronouns that are certainly printed; a nickname
invented as a translation choice governs the passage it was invented for. A row that can cite neither
is refused, which is the rule working.

---

## 4. What is genuinely not finished

- **Nothing in the pipeline reads or writes the store.** No agent tools, no stage calls it, no prompts
  changed. That is correct for slices 2–5 and is the reason they are safe — but it also means **no
  number in `04-implementation-plan.md` §10 has been measured yet.** The cost and quality claims are
  still claims.
- **Slice 4 against the real corpus fails its own criterion** (§3.4).
- **The rendered-output checks were deferred** (a line longer than the file-tool limit; fewer character
  sections than the cast). Deferring them is defensible, but the second one is the check that would
  have *reported* volume 01's damage, and it is the reason slice 4's voice numbers look small rather
  than alarming. It belongs in slice 6, not later.
- **The dev team can no longer fix bugs in this layer.** Intended, and it means a fault here escalates
  to the account owner. That is a real cost of the ban and it should be accepted knowingly.

---

## 5. Gate for slice 6

Slice 6 changes which calls the pipeline makes, so it is not merged on a green suite alone. Before it
starts:

1. §2.1 and §2.2 corrected.
2. §3.1 implemented — otherwise slice 6's import silently drops a fifth of every volume's glossary,
   every run, forever.
3. §3.4's header fix, so the rendered glossary is readable by the code that already reads it.
4. The "fewer character sections than the cast" integrity check added, so a damaged input is reported
   as damage instead of imported as a small store.

Then measure, before anything else: what slice 6 costs on the fixture, against the numbers in
`04-implementation-plan.md` §10.
