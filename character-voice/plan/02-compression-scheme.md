# Proposal: how the character-voice reference should actually be compressed

**Status: PROPOSAL, not implemented.** Companion to
[`01-per-character-reference.md`](01-per-character-reference.md), which documents the failure
this design is meant to remove. `docs/pipelines.md` §6 still describes what the code does today.

Written 2026-10-10.

---

## 0. The fact this whole design hangs on

The pipeline produced a **118,218-character** voice reference for volume 01, at a cost of
171,843,556 tokens.

The translator is never given that document. `utils/translate/references.js` line 235:

```js
const voiceNotes = pickRelevantSections(voiceText, /^### /m, 4000, "character section(s)", sourceText);
```

**The translator receives at most 4,000 characters**, chosen by relevance to the chapter it is
translating.

```
produced   118,218 characters
consumed     4,000 characters   (3.4%)
```

So the artifact's real job — the contract the translation stage actually depends on — is:

> be a store good enough that a **4,000-character relevance-selected slice** of it contains
> the voice guidance this chapter needs.

Everything the current stage does beyond producing that slice is ceremony. The design question
is therefore not "how do we build a big good document cheaply" but **"what store produces the
best 4,000-character slice per chapter, for the least tokens?"**

For comparison, the other injected references and their windows (same function):

| reference | window given to the translator |
|---|---|
| glossary | **unbounded** — treated as law |
| style rules | **unbounded** — law |
| shared wiki | 8,000 chars |
| volume wiki | 6,000 chars |
| POV map | 2,000 chars |
| voice notes | **4,000 chars** |

The glossary is unbounded because it is *lookup-shaped*: the translator gets the rows for the
terms its chapter actually uses. The voice reference is bounded because it is *prose-shaped*.
**The proposal is to make the voice reference lookup-shaped too.**

---

## 1. The store already exists and is being thrown away

The extract stage — one cheap call per chapter — already emits structured claims. Volume 01's
`character-voice-new.json` holds **223 claims**:

```json
{
  "type": "voice",
  "character": "俺（主人公）",
  "quirkType": "pronoun",
  "description": "Uses 俺 for first person and てめぇ for second person when addressing the girl. Switches to 君/貴方 only when performing mock-formal speech.",
  "examples": ["俺は逃にげるわけにはいかない！", "何すんだてめぇ！", "…"],
  "formalityLevel": "mixed",
  "notes": "てめぇ is the default second-person for the girl. 君 appears only in the mock-polite rejection line."
}
```

That is already the compressed, per-claim, append-only form. It cost **1.1 million tokens for
all ten chapters** — 0.6% of the run — and it worked correctly.

Today it is used only by `utils/handoff.js` to render a "what's new in this volume" note. The
expensive stages ignore it and instead re-derive a prose document from the source, ten times
over, each time reading the whole prose document.

**The compression has already been paid for. The pipeline then pays again to throw it away.**

---

## 2. The store

`<volume>/character-voice.store.jsonl` — one claim per line, **append-only**.

```json
{"id":"v01-ch3-017","key":"如月雨露","characters":["如月雨露"],
 "type":"voice","quirkType":"pronoun",
 "claim":"Default second person for the girl is てめぇ; 君 appears only in mock-formal speech.",
 "examples":["何すんだてめぇ！"],
 "formality":"mixed",
 "evidence":[{"chapter":"ch3","line":385,"quote":"何すんだてめぇ！"}],
 "firstSeen":"ch3","lastConfirmed":"ch3","status":"active","supersedes":null}
```

Fields that are new relative to today's extraction output, and why each one exists:

| field | why |
|---|---|
| `key` | `voicePrimaryName` of the character — the identity key the carry-forward guard already uses (`character-voice/carry-forward.js`). Makes "is this the same character?" a lookup, not a reading task. |
| `characters` (array) | Relational claims ("主人公 starts calling コスモス by a new nickname") belong to two characters. This is the case a naive per-character split loses. |
| `evidence` | Every claim carries `chapter:line` + the quoted source span. Makes most auditing deterministic and makes a claim checkable by the repair agent without re-reading the chapter. |
| `firstSeen` / `lastConfirmed` | The thing the grader actually complained about — "systematic mis-dating of quirks across chapters" — becomes a field a deterministic check can validate against `chapters.json`. |
| `status` / `supersedes` | A character's voice *changing* is information, not a contradiction to be overwritten. `superseded` keeps the trajectory; the translator can be told "this changed at ch7". |
| `type: "trajectory"` | A new claim type for the genuinely cross-chapter observations the prose document captured well ("the mock-formal register first appears in ch3 and intensifies in ch4"). Without this, the store loses the most valuable thing the current document holds. See §7.1. |

**Immutable per-volume snapshots.** `<volume>/character-voice.snapshot.jsonl` is the store as of
that volume's completion. This is load-bearing: `fingerprintReferences`
(`utils/translate/references.js`) hashes the *whole* artifact, and a draft is invalidated when a
reference changes. If every volume's drafts depended on one cumulative store, finishing volume 17
would invalidate volume 1's translation. Per-volume snapshots keep today's idempotency intact.

---

## 3. The stages, and what each one costs

```
1. extract      per chapter, one call      UNCHANGED — already cheap, already structured
2. merge        CODE, not a model          new
3. audit        CODE + a graded sample     replaces 10 whole-document AI validators
4. repair       only the characters that failed, one small turn each
5. render       CODE → character-voice.md  the published artifact, same shape as today
```

### 3.1 Merge (no model, with a small exception list)

Appending a claim is a code operation. Three cases genuinely need judgment, and only those go
to a model — as small calls carrying only the items in question:

| case | routed to the model as |
|---|---|
| a new claim's `key` matches no existing character, but resembles one | "are these the same character?" with both profiles (~1k tokens) |
| a new claim contradicts an active claim | "is this a change or an error?" with both claims + their evidence |
| a claim's `firstSeen` conflicts with its evidence location | "which chapter does this quote actually appear in?" — or just resolve it with `grep`, which is deterministic |

Volume 01 has 223 claims and 9 characters. The number of genuine identity/contradiction
questions in that set is small. Compare with what is spent today: **50.8 million tokens** of
compile agents reading a growing document.

### 3.2 Audit: deterministic first, sampled second

Deterministic, free, and it catches what actually broke last run:

- every claim has `evidence` with a quote that really occurs at that `chapter:line`
- no two characters share a `key`; no `key` appears under two spellings without an alias link
- no claim lost its `status`; nothing vanished between the pre-chapter and post-chapter snapshot
- every `firstSeen` is a real chapter id, and no claim's `firstSeen` precedes its evidence
- the rendered document has the expected heading structure and **no line longer than
  `envMaxLineLength()`** — the check whose absence let a 54,341-character (157,566-byte) line through

Then the AI grader scores **a sample** — say three characters chosen at random, plus any
character a deterministic check flagged — instead of reading the whole artifact. Today's
validators cost **60.3 million tokens** auditing a document whose damage was structural and
therefore mechanically detectable.

### 3.3 Repair: targeted, and small

Only the characters that failed a check or a sampled grade. Each repair agent is handed:

```
that character's profile            ~1,000–2,000 chars
that character's claims + evidence  the claims themselves, quoted
the chapter source spans the evidence cites
the chapter's own audit slice       42 KB, not the 245 KB merged report
```

…instead of the whole cumulative document plus the whole-volume audit. Today's repair agents
were handed ~274,000 characters and made 24 reads and 29–40 edits on a file they could not
read, at 8.6–17.7 million tokens per chapter.

Because the store is append-only, a repair agent **cannot** damage another character. That is
the structural answer to the failure in `01-per-character-reference.md` §2.1.

---

## 4. Rendering: the published artifact does not change shape

`character-voice.md` is generated from the store by code:

```
# Character Voice Reference — <series>
_Current through volume 01（…）._

## Characters

### 如月雨露（ジョーロ）＝主人公【俺人格】
- **Pronouns**: …
- **Catchphrases**: …
- **Trajectory**: mock-formal register first appears ch3, intensifies ch4 (v01-ch3-017, v01-ch4-004)
- **Changes at**: ch7 — begins using 君 (v01-ch7-011)
- **Evidence**: ch1:219, ch3:385, ch7:12
```

Why render at all, if the store is the real artifact:

- every downstream reader names `character-voice.md` (105 references across 30 code files,
  11 prompt files) — see `01-per-character-reference.md` §5
- `pickRelevantSections` splits on `^### `, and the acceptance test's `voiceSections` signal
  counts `### Character` sections (`utils/delivery-verify/signals.js`)
- the consistency audit reads the four artifacts as documents
- a human can read it

Rendering by code also means the rendered file is **always well-formed** — headings, line
lengths and section counts are outputs of a function, not artifacts a model might damage.

### 4.1 Better injection than today's

`selectSectionsByRelevance` matches a section by its heading or a quoted source pattern
appearing in the volume. With a store, relevance becomes a direct lookup: **the characters whose
`key` or aliases appear in this chapter's source.** More precise, and it can rank by frequency
so the 4,000-character window holds the characters who actually speak in the chapter rather than
the ones whose headings happened to match.

Two-tier injection, which fits inside 4,000 characters and is more useful than today's truncation:

```
tier 1  a ~200-char card for EVERY character in the cast          always
tier 2  the full profile for the characters who appear in THIS chapter   ranked by how often they speak
```

Today, if the cast is large, the 4,000-char window silently drops whoever does not match — and
the truncation note is the only trace. With a card tier, nobody is ever absent.

---

## 5. Cost: measured today vs projected

Measured, volume 01:

| stage | today | tokens |
|---|---|---|
| extract | 10 one-shot calls | 1,103,160 |
| compile | 10 agents, each reading the growing document | 50,811,712 |
| validate | 10 agents, each auditing the whole document | 60,299,124 (+4,077,180 recovery) |
| findings merge | 1 agent | 1,603,030 |
| grade | 1 call reading ~250k chars | 293,032 |
| feedback | 4 agents before the run died | 53,656,318 |
| **total** | | **171,843,556** |

Projected under this design: extract unchanged; compile → code + a handful of small conflict
calls; validate → code + a 3-character sample; feedback → targeted per-character turns.

**Estimate: 3–8 million tokens per volume.** A 20–50× cut.

This is an estimate, not a measurement, and it must be measured before it is believed —
`npm run pipeline-loop` plus `test/prompt-audit.js` gives the offline numbers, and one real
volume gives the honest ones. The reason to be optimistic is specific: every expensive stage is
expensive because it re-reads a growing document, and this design removes the re-reading rather
than asking the model to think less.

Note the token/time split from the failed run, because it says *what* gets cheaper:

```
input  (re-read)   166,711,658   97%   → cheap in wall clock here (the server caches prefills),
                                          but this is what exceeded the window and killed the run
output (generated)   5,131,898    3%   → this is the wall clock: ~5.1M tokens ≈ 13 hours
```

---

## 6. What this removes from the failure

| failure in `01-…md` | removed how |
|---|---|
| an agent must hold the whole cumulative document | nobody ever does; a merge is code, a repair sees one character |
| the document's line structure was destroyed by edits | the published file is generated by code; agents never edit it |
| damage to one character spread to the whole reference | append-only: a repair touches one character's claims |
| the loss guard was fooled by destroyed headings | the guard compares claim ids in a store |
| mis-dated quirks across chapters | `firstSeen` is a field, validated against `chapters.json` and its own evidence |
| repair agents re-trod other chapters | they are scoped to a character, not to a whole-volume work order |
| the whole-volume audit report handed to a chapter's agent | the chapter's own slice, or the character's own claims |
| a 48/100 document published silently | deterministic structural gates run before rendering, and cannot be overruled by `ON_QA_LIMIT` |

---

## 7. What this risks losing — the honest part

### 7.1 A claim store loses narrative insight

The current prose document contains genuinely valuable cross-chapter observations of the form
"this register first appears in ch3, intensifies in ch4, and is abandoned by ch7". A store of
atomic claims captures that only if the schema has a first-class claim type for it. It must
(`type: "trajectory"`), and the extract prompt must ask for it explicitly. **If this design is
implemented without trajectory claims, it is a worse system than the one it replaces.**

### 7.2 Relational claims

A fact about two characters must be stored once with `characters: [a, b]` and surfaced to both,
not duplicated. If it is duplicated, the loss guard will read a legitimate edit to one copy as a
loss of the other.

### 7.3 Cast identity is the hard problem

Two store entries for one character (an alias used as a name) is worse than a monolith, because
the guard keys on `voicePrimaryName`. The existing alias-resolution logic in
`compareVoiceCarryForward` already resolves this for the glossary and the voice reference; it has
to run at merge time, before a claim is written, not afterwards.

### 7.4 Two artifacts where one was expected

The volume folder then holds a store, a snapshot, a rendered document, and the existing
validation/state files. That is more files, and `utils/artifacts/preproduction.js` declares the
expected outputs. The store and snapshot must be declared (or explicitly whitelisted), or the
post-mortem reports them as strays and the resume wipe lists leave them behind.

### 7.5 It does not fix the wall clock of the other stages

Glossary, style-guide and jump-in-wiki are cumulative documents with the same shape and the same
growing-document cost curve. This design is written for character-voice because that is where the
damage and the measurement are. The same pattern applies to all three — the wiki is already
lookup-shaped in how it is injected — but each needs its own claim schema.

---

## 8. Migration, in slices that each keep `npm test` green

Per gotcha 69, every test uses a throwaway fixture series (`test/fixture-series.js`); none may
reach the real 17 volumes.

1. **Stop throwing the extraction away.** Feed `character-voice-new.json` claims into the
   compile turn instead of only into the handoff summary. Small, and it makes the claim shape
   load-bearing before anything else depends on it.
2. **Add `key`, `evidence`, `firstSeen`, `status` to the claim schema**, with a writer that keeps
   the old JSON file readable. Test: the schema round-trips; a claim without evidence is refused.
3. **Code merge for the non-judgment cases**, with the three judgment cases routed to small
   model calls. Test: a merge appends, resolves identity, and never rewrites an existing claim.
4. **Deterministic integrity checks** + the "no line longer than the read limit" gate + a sampled
   grade replacing whole-document validation. Test: each planted defect is caught at the right
   severity, mirroring `test/test-postmortem.js`.
5. **Render `character-voice.md` from the store.** Test: the rendered file satisfies
   `hasDocumentShape`, `parseVoiceSections`, the `voiceSections` signal, and byte-stability for an
   unchanged store.
6. **Two-tier injection** in `utils/translate/references.js`, behind `REFERENCE_SELECTION_VERSION`
   so every dependent draft invalidates deliberately (gotcha 27). Test: the card tier is never
   dropped; the full tier is ranked by appearance in the chapter.
7. Only then: **targeted per-character repair.**

Slices 1–4 are worth doing even if the rendering idea is rejected.

---

## 9. Open questions for the account owner

1. **Trajectory claims.** How much cross-chapter narrative observation must the store preserve?
   This decides whether the store is a lookup table or something closer to a timeline, and it is
   the main defence against losing what the prose document captured well.
2. **Is the unit a character or a character-section (persona)?** Carried over from
   `01-per-character-reference.md` §10.1. The store's `key` forces the answer.
3. **Should the store be committed with the books?** It is the artifact's source of truth, and it
   is regenerable only at full cost. That argues for committing it.
4. **Sample size for the graded audit.** Three characters per volume is a guess. The existing
   grader calibration harness (`npm run calibrate`) is the right place to find out how small the
   sample can be before the grade stops meaning anything.
5. **Does the same design apply to the style guide and the wiki**, and in what order?
