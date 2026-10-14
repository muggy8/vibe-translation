# Plan: a declared register system, and a voice record that ages

**Status: PLAN — direction approved by the account owner 2026-10-14. Slice 0 is BUILT (2026-10-14);
slice 1 is MEASURED (2026-10-14, no door built — see §2.11); slices 2–7 are not implemented.**

Two decisions were taken before this plan was written, and they are the plan's premises:

1. **The register questions are declared per series, not listed in code.** The intake decides both
   *what the questions are* and *what answers this language offers for them*, from the book. Adding a
   language means adding a declaration, not editing the pipeline.
2. **The plan is written before the stage is run.** The measurements below are from the code and the
   schema, not from a real voice extraction — there is none on disk. Slice 0 is the cheapest thing
   that can be done, and the first real run is deliberately placed *after* slice 2 so that the run
   exercises the declared shape rather than the Japanese one.
3. **A register decision is made per volume, not once per series.** A character's voice changes as the
   story develops, and accuracy means conveying what they are like *at that moment*; the claim's validity
   span is what keeps the record correct when a later volume invalidates an earlier answer. This is the
   point where the voice stage deliberately does **not** follow the glossary (§5, §6, §9).

---

## 1. The problem, in one paragraph

The character-voice stage asks a fixed list of questions about a fixed language. Its prompt names
Japanese speech levels, Japanese pronouns, Japanese regional varieties and Japanese page markers, and
its answer shape closes those names into enumerations — so a Korean, Chinese, Spanish, French or
German book would be forced to answer "which of these five Japanese politeness levels?" and to look
for a `※` that its books never print. At the same time the record underneath it, which was designed
to hold a claim that *stops being true* at a given volume, has no stage that ever closes a claim's
span: a character whose speech changes in book 6 keeps book 1's description published as current
forever, because the door that would replace it exists and is wired to the glossary only. Meanwhile the
glossary has already solved the harder half of this — its record carries the accumulation so its read
pass never has to hold it — and the voice stage has not, so its cost grows with everything already
learned about the cast, 133 times over.

---

## 2. The evidence (measured 2026-10-14)

### 2.1 The prompt is one language's list

`system-prompts/character-voice-extract.md`, 112 lines:

| Line | What it hard-codes |
|---|---|
| 1 | "a long-running **Japanese** light novel series" |
| 10 | sentence endings as `〜だぜ`, `〜である`, `〜でござる`, `〜だにゃ` |
| 11 | first person as 俺 / 私 / 僕 / あたし |
| 12 | formality as 丁寧語 / 普通語 / 尊敬語 / 謙譲語 |
| 15 | dialect as 関西弁, 九州弁 |
| 24–30 | point-of-view markers as `※`, `☆`, `◇`, `◆`, `【】`, `（）`, `――` |
| 44 | a Japanese passage as the worked example of the hardest thing to detect |

**7 of the 23 files in `system-prompts/` name Japanese or Japanese text** (`character-voice-acceptance`,
`character-voice-extract`, `style-guide-acceptance`, `style-guide-extract`, `style-guide`,
`style-guide-validator`, `translation-target`). The voice stage is not the only one, but it is the one
whose *answer shape* is closed around the language.

### 2.2 The answer shape closes the language into enumerations

Same file, the declared output:

- `quirkType` — 7 values (line 66)
- `formalityLevel` — `polite | plain | honorific | humble | mixed` (line 69)
- `povCategory` — 5 values (line 78)
- `narrationType` — 5 values (line 82)

`formalityLevel` is the sharpest case: four of its five values are the names of *Japanese* politeness
categories, and Korean speech levels, French *tu/vous*, Spanish *tú/usted/vos* and German *du/Sie* have
no value to go in.

### 2.3 Four of the seven kinds collapse into one, in the store

`utils/reference-store/extraction-adapter.js:59-67` maps the prompt's kinds onto the record's aspects:

| prompt kind | stored aspect |
|---|---|
| `sentenceEnding` | `register` |
| `formality` | `register` |
| `vocabulary` | `register` |
| `dialect` | `register` |
| `pronoun` | `pronoun` |
| `catchphrase` | `catchphrase` |
| `internalVoice` | `internal_voice` |

Four different questions become one aspect. The record therefore cannot answer "how formal does this
character speak" separately from "which words does this character use" — which are exactly the two
things a translator needs to be told separately. Anything the prompt did not list is filed as
`unclassified` (`:69`), which the integrity audit counts and reports.

### 2.4 The time dimension exists in the schema and is used by nobody

`utils/reference-store/schema.js:216-238` gives every claim:

```
established_volume    INTEGER NOT NULL
applies_from_volume   INTEGER NOT NULL
applies_to_volume     INTEGER            -- NULL = still holds
status                'active' | 'superseded' | 'disputed' | 'retracted'
supersedes            TEXT REFERENCES facts(id)
formality             TEXT
```

`character-voice/plan/03-database-backed-references.md:103` is where the design intent was written.
What the measurement found is that the intent was never wired:

- **No stage ever fills `applies_to_volume`.** It is written by `facts/insert.js:148` as `null` when
  absent and carried unchanged by `facts/amend.js:84`. The only prose about it is a repair hint in
  `facts/validate.js:48`: *"leave `applies_to_volume` null while the fact still holds."* Nothing ever
  decides that a fact stopped holding.
- **The door that marks a row replaced is called from one place in the whole repository**:
  `utils/reference-store/glossary-adapter/revision.js:149`. The voice side has no caller.
- **The read that means "the record's current claim" already works** — `currentClaimSql`
  (`utils/reference-store/facts/challenge.js:185`) excludes retracted rows, rows a live row supersedes,
  and rows with an unresolved dispute. It is shared by all three renderers. So the machinery for
  "what is true now" exists; nothing files the row that would make it change.
- `supersede.js`'s own header already states the distinction this plan depends on: `disputed` is the
  mark for *a claim somebody disagrees with*, `superseded` is the mark for *a claim a later volume
  replaced*. A character development is the second thing, and today it can only be filed as the first.

### 2.5 The confirm-or-contradict question is already being asked, with nowhere to answer

`system-prompts/character-voice-extract.md:49` tells the model: *"If a character's quirks are identical
to what's already in the previous reference, note them as 'unchanged' rather than duplicating."* The
model is asked to report confirmation and gets no destination for it. Nothing in the record distinguishes
"we looked at book 5 and this still holds" from "we never looked again".

### 2.6 The glossary stopped showing the model its accumulated reference. The voice stage did not.

This is the largest structural difference between the two stages, and it is the one that decides how
much of the glossary's shape can be copied.

| | the glossary's read pass | the voice read pass |
|---|---|---|
| what the model is shown | **the chapter, and nothing else** | the chapter **plus the previous volume's published reference** |
| where the accumulation lives | in the record | in a markdown file handed to every call |
| measured | `glossary/extract.js` and `glossary/store.js` contain no `inlineReferenceMessage`, no `previousGlossary`, no `stateFile` | `character-voice/reading.js:369` passes `ctx.previousVoiceRefFile` to **every** chapter's call; `:442` says so outright — "the reference every chapter is shown" |

The glossary's *older* routes still inline it (`glossary/task.js:584`, `glossary/chunked.js:139`), but the
read pass that replaced them does not: **the record carries the accumulation, so the model never has to
hold it.** That is why the real 17-volume glossary run reported **zero** reference truncations — a grep
for the door's own notice (`[context] inlining … truncated`) across every run recorded in
`<SERIES_LOCATION>/.run/logs` returns nothing.

The voice stage has the door and it is firing. Both stages use the same limits — a 64 KB threshold and a
200-unit cap (`character-voice/config.js:34,36`; `glossary/config.js:49,57`) — and the voice picker keeps
whole `### ` character sections ranked against the chapter (`character-voice/stages.js:100-109`). Against
the only growth curve this repository has, the real per-volume glossary files:

```
volume 01    37,540 bytes     volume 07  208,959 bytes     volume 13  310,575 bytes
volume 02    75,766 bytes     volume 08  222,090 bytes     volume 14  320,444 bytes
volume 03   109,053 bytes     volume 09  241,927 bytes     volume 15  329,308 bytes
volume 04   136,413 bytes     volume 10  251,947 bytes     volume 16  340,818 bytes
volume 05   161,452 bytes     volume 11  276,323 bytes     volume 17  358,233 bytes
volume 06   184,192 bytes     volume 12  294,863 bytes
```

**9.5× growth, and the 64 KB line is crossed at volume 02.** Sixteen of seventeen volumes would be cut
down if they were shown. The voice reference is not smaller than the glossary: `AGENTS.md` records
volume 02's published voice reference at **583 bullets** against that volume's **124 glossary rows**, and
the record holds no voice claims for any volume today, so no voice file exists to measure directly. The
same curve therefore arrives sooner for voice, not later — and it arrives **133 times**, once per chapter,
rather than 17 times.

### 2.7 What the pronoun problem is currently solved with

- `cast_alias` — a **name-matching** device — is used to declare that 僕 and 俺 belong to 如月雨露,
  read out of the glossary's own Characters row (gotcha 117). It makes the roster fold fire, and it is
  the only reason a bare pronoun does not become its own roster entry.
- `formality` — a free-text string copied from the model's own `formalityLevel`
  (`extraction-adapter.js:169`).

Neither is a **decision**. "This character's self-reference is rendered as *I*, flat and blunt" is a
choice that must hold still across 133 chapters, and today it exists only as prose in a markdown file a
translator reads. Second-person address is captured as one `pronoun` claim with no relationship attached
to it — the record has no way to say *who* is being addressed that way.

### 2.8 Cost anchors for what a change touches

| | measured |
|---|---|
| one volume's reading pass, real volume 02 | 1,657,482 tokens, 14 calls, 7 chapters |
| the removed author route, real volume 01 | 166,370,184 tokens, 25 agent turns |
| the whole glossary series, 17 volumes | 13,851,146 tokens, 299 calls |
| the series' chapters | 133 |

The reading pass is the only thing in the voice stage that costs anything, so a change that rides inside
the chapter call costs nothing extra; a change that adds a call per chapter costs 133 calls.

### 2.9 The roster double-counts people, and the mechanism meant to fix it has no input

Measured 2026-10-14 against **copies** of all 17 volume records (`/tmp/opencode/cast-survey.js`,
0 model calls, gotcha 124 respected):

| | measured |
|---|---|
| distinct cast rows across the 17 records | **196** |
| cast rows carrying an alias declaration | **0** |
| `cast_merges` rows (the roster fold actually performed) | **0** |
| cast rows keyed by 僕 or 俺 | **0** |

The glossary's own Notes say the duplication outright — volume 17's `## Characters` section holds
**both** 如月雨露 ("The narrator and protagonist… His nickname ジョーロ comes from removing 月 from 如月")
**and** ジョーロ ("The narrator's nickname… **Used constantly by all other characters to address him**"),
and the same pair for 日向葵 / ひまわり. They are separate roster entries with nothing linking them. A
coverage guard keyed on the roster therefore asks for a voice entry per nickname.

**And the door that was built to close this is reading a row that is no longer written.** Gotcha 117's
mechanism is `importGlossary` reading the glossary's Characters row *"Narrator: switches between 僕 and
俺"* and declaring both pronouns as aliases. All 17 published glossaries have a `## Characters` section.
**None of the 17 contains the string "switches between"** — the row was written by the author agent that
`renderGlossary` replaced (glossary route slice 2), and the render does not produce it. The published
records confirm the consequence: 0 aliases, 0 merges.

### 2.10 The cast's shape, which decides how a "miss" should be judged

The same survey, on recurrence:

```
appears in  1 volume :  17 characters   (every one of them: exactly 1 chapter mention)
appears in  2 volumes:  11              appears in  9 volumes:  7
appears in  3 volumes:   2              appears in 10 volumes:  9
appears in  4 volumes:   4              appears in 11 volumes: 16
appears in  5 volumes:  12              appears in 12 volumes:  8
appears in  6 volumes:   8              appears in 13 volumes: 13
appears in  7 volumes:  10              appears in 14 volumes: 15
appears in  8 volumes:   6              appears in 15 volumes: 19
                                     appears in 16 volumes: 22
                                     appears in 17 volumes: 17
```

**The split is bimodal and unambiguous in this series**: a core cast that recurs, and a tail of 17 names
that appear once, in one volume, in one chapter. No judgement call is needed to separate them here.
Whether that holds for a series with a one-volume pivotal character is the open question §10.7 records.

### 2.11 What actually states a link, measured per source (slice 1, 2026-10-14)

Slice 1 asked the question §2.9 leaves open — *is there a source that states which of these entries
are the same person?* — and measured every candidate. 0 model calls, run against **copies** of the
17 records (`/tmp/opencode/roster-survey.js`, output `/tmp/opencode/roster-survey-output.txt`; the
prose shapes measured separately by `/tmp/opencode/roster-shape-audit.js`).

**Where the 196 entries come from: all 196 are glossary Characters rows.** The distinct terms across
the 17 published `## Characters` tables are 196, and every cast key is one of them. The roster *is*
that table, copied into `cast` by `importGlossary` — so every name the glossary model noticed is a
roster entry, and a character the glossary described under two names is two entries by construction.

| Source | Shape of the data | Links it **states** | Entries covered |
|---|---|---|---|
| `cast.aliases` | structured | **0** | 0 |
| `cast_merges` | structured | **0** | 0 |
| `cast_presence_match.name` | structured | **0** — 196 distinct (key, name) pairs, and every matched name is the key itself | 0 |
| `facts.extracted_as`, `character-voice*.md` on disk | structured / file | **0** — no voice run has produced a row yet | 0 |
| `document_prose`, `attribution_answers` | structured | **0** | 0 |
| **`<base>-ruby-guides.json`** | **structured — the book's own markup** | **13 pairs** (20 guide rows across the 17 volumes) | **24 of 196 (12%)** |
| the glossary's Characters rows, in the **markdown** | a table cell of **model-written prose** | **56 pairs** (644 of 1,309 rows that name another key state a link; 665 only mention one) | 88 of 196 |
| the same rows, already inside the **record** (`facts`, `section='Characters'`) | the same prose, stored | **56 pairs** (703 of 2,037 row-copies) | 88 of 196 |

Union: **59 stated pairs → 35 groups → 91 entries, 56 of them duplicates of another entry; 105
entries no source links at all.** The largest group is 6 entries for one person (パンジー / 三色院菫子
/ 虹彩寺菫 / ビオラ / 董子 / 三色院董子); the pair §2.9 names, 如月雨露 / ジョーロ, is stated **only**
by glossary prose, not by the book's markup.

**The one structured source is the ruby-guide file, and it does not answer the question a merge
needs.** It states *that* an annotated word is called by another name — 三色院菫子 → パンジー (18
annotations), 日向葵 → ひまわり, 秋野桜 → コスモス, 羽立桧菜 → あすなろ — but it does not state *which
of the two roster entries is the character*. Taking the markup's own direction (the annotated word
survives, the reading folds into it) would merge **パンジー, a 17-volume entry, into 虹彩寺菫, a
4-volume one**, because volumes 15–16 print 虹彩寺菫 with the reading パンジー 406 times. `castAlias`
requires a survivor and a reason; the source supplies neither. It also misses 大賀太陽 → サンちゃん
outright, because the ruby is spelled サンちやん and the roster spells サンちゃん (2 rows).

**And the prose rule was measured before it was trusted.** The obvious shape — *`<K>'s nickname`* —
fires **49 times on 5 pairs, and all 5 pairs are wrong**: "アネモネ's nickname for 芝" produced
しばにゃん ↔ アネモネ, because the possessive names the character who **coined** the nickname, not
the character it describes. That shape is dropped. The seven shapes that survived produce 56 pairs
with no wrong pair found in the list — **and one of the 56 is a pair a rule that read its own
sentence would have refused**: ミスターＴ ↔ サンちゃん, filed seven times (volumes 11–17) from the line
*"The T comes from his given name 太陽 (Taiyō), **not** from his nickname サンちゃん."* The identity is
true — both are 大賀太陽, and the survey's own group list puts them together — but the sentence states
it by **denying** the derivation a link-shape would be looking for. So the surviving 56 are a list a
person has to read, not a list a rule can be trusted to produce. This is gotcha 117's rule confirmed
from the other side: a rule that reads a naming sentence can be 100% wrong while looking exactly as
narrow as the ones that work, and it can also be 100% right for a reason the sentence does not state.

**Two facts that decide what slices 2 and 9 can promise.** First, **no fact in any of the 17 records
is keyed to a cast entry** — 22,469 rows, 0 of them with a `key`. Slice 2's "which known register
facts belong to the characters this chapter contains" currently has nothing to return, and slice 9's
coverage guard currently has nothing to measure coverage against. Second, the extraction's answer
shape has one field, `"character"`, and `resolveExtractionName` **creates a cast entry for any name
it cannot resolve** — so the stage that produces the duplication is the stage that has no field in
which to state the link.

**What slice 1 did not build, and why.** No door. The only source that states links without being
model-written prose covers 12% of the roster and cannot say which entry survives a merge; the source
that covers 45% of it is prose, and the measurement above shows a prose shape failing completely
while looking sound. Filing a wrong merge is the one operation in `utils/reference-store/` that makes
a character's claims vanish from a query. The four decisions that would have to be taken first are
written in `/tmp/opencode/roster-slice1-questions.md`.

---

## 3. What this plan must not rebuild


The copy-forward model transfers to voice better than it looks, because the glossary does not copy a
document and edit it. It copies forward **unmodified**, and a change is a **new row filed beside the old
one**; the published file is a *rendering* of the record, not an edited artifact. That is the shape a
character's development needs: a book-1 voice is not wrong in book 9, it is **dated**.

So these stay exactly as they are: the chapter-by-chapter read, the two-paid-read budget, the answer
envelope, the evidence rule (a quote must actually be in the book), the deterministic audit, the grade,
the seal, the copy-forward, the quarantine, and "a sealed row is never edited".

---

## 4. The design: a register declaration, per series

### 4.1 Where it lives

`translation-target.json`, which `npx gulp discover` already writes and `intake/validate.js:54` already
requires to carry `seriesName`, `sourceLanguage` and `targetLanguage` — and whose discovery confidence
(`intake/validate.js:231`) already covers "the order, the name, or **the language**". The intake is
already the step that works out what this series is; the register declaration is the same act, taken one
step further.

### 4.2 What code knows, and what the series declares

**Code knows the shape of a question and nothing about any language.** A declared axis is:

```
id            a stable name for this axis in this series
asks          the question, in plain language, answerable from the book
values        the forms THIS language prints for it — an open list, from the book
scope         whether the answer is per character, or per (character, addressee) pair
renders       what the translation renders each value as — the decision, per value
evidence      the forms the intake actually saw, and where
```

There is **no axis list in code**. Not a Japanese list, not a universal list of four concepts, not a
fallback. A series that distinguishes one axis declares one axis; a series that distinguishes six
declares six. The pipeline's job is to ask each declared question of each chapter and to file the
answers, not to know what the questions should have been.

### 4.3 The guards that make a bad declaration visible instead of silent

A declaration chosen by a model is a decision that shapes 133 chapters, and nothing pins the questions.
That is the risk the owner's choice accepts, and these are the guards that keep it honest. All four are
computable without a model.

1. **Every claim must quote the book.** The existing evidence rule already refuses a claim whose quote
   the source does not print. It applies to register claims unchanged.
2. **A value outside the declared set is refused at filing**, and named. A model that invents a
   politeness level this book does not use produces a refusal, not a row.
3. **An axis that produces no evidenced claim in a volume is reported.** If a declared axis is answered
   zero times across a whole volume, that is a finding — the axis is unanswerable as declared, and the
   honest reading is that the declaration is wrong, not that the book is silent. A new kind in the
   seriousness table, which moves the pinned count from 68.
4. **An axis answered for a character with no presence in this volume is reported** — the same question
   the attribution pass already asks (gotcha 121), reused rather than re-invented.

### 4.4 What this replaces

- `formalityLevel`'s five-value enumeration becomes a value drawn from the series' own declared set.
- `quirkType`'s seven fixed kinds stop being the record's aspect vocabulary. The aspect comes from the
  axis the claim was filed against.
- `cast_alias` goes back to being only what it is — a name-spelling device. Pronoun ownership stops
  being smuggled through name matching, because a register claim answers "who uses which self-reference"
  directly.
- The point-of-view markers move from the prompt's list into the declaration, because `※` is a
  convention of this language's publishing, not a universal one.

---

## 5. The time dimension: confirming, contradicting, replacing

Three separate acts, and the record already has a name for two of them.

| Act | What it means | What the record does |
|---|---|---|
| **confirm** | this volume's text shows the same thing again | new — needs a home |
| **contradict** | this volume's text shows something different | file a new row, mark the old one `superseded`, close its span |
| **dispute** | somebody thinks the published claim is wrong | `challenge_fact` → `disputed` — already built, already used by the attribution pass |

**Replacing is not disputing.** `supersede.js`'s header says this outright. A character development is
not a claim that somebody is wrong; it is a claim that stopped holding. The voice stage needs the door
the glossary has: file a new row that names the row it replaces, owned by the volume whose own text
carries the change, with its own quote — and the old row survives, unchanged, as the arc.

**And for voice, a replaced claim is not a wrong claim.** This is where the voice record must *not*
follow the glossary. For a term, the newest rendering is the law: a thing has one name and a translator
of book 3 should use the name book 17 settled on. For a character, the replaced claim was **true during
its span** — it is the record of how they spoke *then*, and it is what makes the change visible as
development rather than as a contradiction. Closing `applies_to_volume` is therefore not bookkeeping on
top of the voice stage; it is the thing that lets a per-book answer be correct. The query that means
"what holds as of volume N" already exists (`utils/reference-store/queries.js:61`:
`applies_to_volume IS NULL OR applies_to_volume >= ?`); what is missing is any stage that ever fills the
column in.

**Confirming needs a decision the owner has to make.** A confirmation carries no new claim body, so
storing one as a claim duplicates the body six times across a series. The options:

- **A lightweight row** in its own table — "volume 5, axis X, character Y, confirmed" — so the render can
  say *confirmed in volumes 1–6* without six copies of the same sentence. Costs a schema version bump.
- **Nothing** — leave `applies_to_volume` null and let "still holds" stay an assumption. Costs no schema
  change and is exactly the state that produced §2.4.
- **A claim row each time** — evidence-backed and dated, but it inflates the artifact and makes the
  coverage rules count the same fact repeatedly.

Recommendation: the lightweight row. The whole point of this plan is that "still holds" should be an
observation rather than an assumption, and the second option is the assumption.

**Where the answer comes from for free:** the chapter call already sees the previous reference and is
already asked to say "unchanged" (§2.5). Giving that answer a destination costs no extra call — it costs
a slightly larger answer, which is the cheaper of the two currencies here.

---

## 6. The render: now, the arc, and the decision

`character-voice.md` today renders bullets per character. Under this plan it renders three things per
character:

1. **How they speak in this volume** — the claim that holds *as of this volume* for each declared axis,
   which is what a translator of this book needs, and which the span query in §5 already answers.
2. **How they got there** — the superseded rows, dated to the volume that established them and the
   volume that replaced them. The glossary already prints this shape as `Earlier rendering:`.
3. **The decision** — for each axis, what the translation renders that value as. This is the thing a
   translator must be able to rely on, and it is the thing that does not exist today in any structured
   form.

**When the decision is made: per volume.** Answered 2026-10-14 by the account owner, and the reason is
the plan's premise: a character's voice changes as the story develops, and accuracy means conveying what
they are like **at that moment**, which the `applies_from` / `applies_to` span exists to make correct
even when a later volume invalidates the answer.

That choice is already half-implemented, on the consumer side. `utils/translate/references.js:96-103`
hands the translator **that volume's own** `character-voice.md` and `pov-map.md`, read out of the volume
folder. Only the glossary half of that same function was switched to the settled record. So the thing a
translator actually receives is already per-book; what is missing is the machinery that makes it
period-correct rather than "everything observed, as of whenever it happened to be rendered".

Four things follow mechanically:

1. **A decision is a dated row, owned by the volume that made it** — not a series-level fact. Its span
   begins at the volume it was made for and closes when a later volume replaces it.
2. **Each volume's artifact is rendered from that volume's own record**, which is a snapshot ending at
   that volume (volume 3's record holds volumes 1–3 and nothing later). That is what makes a book-3
   answer a book-3 answer, and it is already how the per-volume records work.
3. **The decision is made at the volume boundary**, after every chapter of that volume has been read.
   Chapters feed observations; the boundary decides. This is what stops a claim that flickers between
   chapters from changing a translator's instructions mid-book — the problem this section was open about
   is answered by *where* the decision is taken, not by delaying it.
4. **A later volume never rewrites an earlier volume's file.** The freeze gate already refuses that once
   a translation stands on it, and `npm run release-translation` is the only way past.

**The risk this accepts, and the guard for it.** A change that is really extraction noise — one over-read
line in book 4 — will be rendered faithfully as character development. Two computable checks, no model
judgement:

- **A reversal is reported, not honoured silently.** A claim replaced, and that replacement replaced by
  something equivalent, is the shape noise makes and development does not.
- **A change resting on one quote is weaker than one resting on five**, and the record already stores
  each claim's evidence, so the render can say how solid the change is instead of presenting every
  change as equally real.

**What must not be copied from the glossary.** `utils/translate/settled-glossary.js` deliberately reads
the *highest-numbered* volume's record, because a term should have one name across the whole series. The
voice reference must come from **the volume being translated**. Applying the settled-record door to voice
would hand a translator of book 3 the answers book 17 had not discovered yet, and would quietly delete
the arc this plan exists to preserve.

---

## 7. The wiring gap that has to close first

The voice read pass is shown a **document** — the previous volume's published `character-voice.md` — and
it is shown it 133 times. The glossary stopped doing this: its record carries the accumulation, and the
model sees only the chapter it is reading.

This is not only a cost problem. It is a correctness problem for everything §5 is about:

- A chapter cannot be asked *"does this confirm or contradict what we already know?"* while being shown a
  document that may still assert what the record has already replaced. The file is a render; the record
  is the truth; today the model is shown the render.
- The reference the chapters are shown is cut to 200 character sections ranked by a word-match against
  the chapter (`character-voice/stages.js:100-109`). From volume 02 onward that is a **lossy view chosen
  by string overlap**, and a character who speaks in this chapter under a spelling the matcher cannot see
  is a character whose known register is not shown to the call that could have confirmed it.
- The translation stage had the same shape of defect and it was closed: `utils/translate/settled-glossary.js`
  reads the settled record, and a series with no readable record **refuses structurally rather than
  falling back to the markdown**. The voice read pass has no equivalent.

**The direction is not "show it a bigger file".** It is the glossary's direction: ask the record *which
known register facts belong to the characters this chapter actually contains*, hand the call that answer,
and let the record carry everything else. That is smaller than what the stage does today, it is the shape
that makes confirm-or-contradict answerable, and it is the same door the translation stage already walks
through.

---

## 8. Slices, in order

Each slice states what it has to prove. None of them runs the real corpus.

| # | Slice | What it must prove |
|---|---|---|
| **0** | **BUILT 2026-10-14.** Wire the voice reading pass into the finding channel, and add the kind for a chapter that never answered. | Done: `character-voice/findings.js` builds `voice-chapter-never-answered` (HIGH / **MAJOR**) and `voice-chapter-kept-cut-off` (MEDIUM / **MINOR**) from the chapter record the reading pass already wrote, and `character-voice/task.js` hands them to `reportVolumeFindings` in a `finally`. **0 model calls, 0 new settings, every call baseline unmoved** (82 / 17 and 28 / 6 in the offline loops, 0 on the second pass in both). The kind count moved **68 → 70** and `test/test-finding-levels.js` 478 → 492 checks; `test/test-voice-reading-findings.js` (160 checks) proves it end to end through the real runner: the assessment names it at the table's level, the ledger counts it, the triage routes it as damage and resumes at the damaged volume, the never-attempted volume costs nothing, and a volume whose reading pass never ran writes no record. **What it did not get:** the volume-boundary halt record does not fire for this kind, because the gate assesses a volume only after that volume's work returns and this stage throws — gotcha 149, and `/tmp/opencode/voice-findings-slice0-questions.md`. |
| **1** | **MEASURED 2026-10-14; no door built, and the measurement is the answer.** The roster: is there a source that *states* who is who? | **Done, as a measurement.** The roster is the glossary's Characters table — **all 196** cast keys are one of the 196 distinct terms those tables publish. Structured sources state **nothing**: `cast.aliases` 0, `cast_merges` 0, `cast_presence_match.name` 0 (every matched name is the key itself), `extracted_as` 0, no voice file on disk. The **only** structured source that states a link is `<base>-ruby-guides.json`: **13 pairs, 24 of 196 entries (12%)** — and it states the link without stating *which entry is the character*, so its own direction would fold パンジー (17 volumes) into 虹彩寺菫 (4 volumes). The glossary's Characters rows state **56 pairs / 88 entries**, in the file **and already inside the record**, but that is model-written prose, and the obvious shape for reading it — `<K>'s nickname` — was measured at **49 hits, 5 pairs, 5 of 5 wrong** and dropped. Union: 59 pairs, 35 groups, 56 duplicate entries, **105 entries no source links**. Also measured: **0 of the 22,469 facts in the 17 records is keyed to a cast entry**, so slices 2 and 9 have nothing to query yet. **No door, no new setting, no new finding kind, 0 model calls, no corpus file touched.** The four decisions a door needs first are in `/tmp/opencode/roster-slice1-questions.md`. |
| **2** | The voice read pass stops being shown a document and is shown a **query result** instead: the known register facts for the characters this chapter actually contains, read out of the record, refusing structurally when there is no readable record. | Two numbers, both measured with 0 model calls. **Correctness:** a superseded claim stops reaching the chapter's prompt. **Size:** the bytes each chapter is shown go *down* against what the stage does today, measured across the 17-volume curve in §2.6 — this slice is not allowed to make a prompt bigger. |
| **3** | The declaration exists: intake writes it, `intake/validate.js` checks its shape, the voice stage reads it, and the extraction's answer shape takes its value sets from it instead of from the prompt's enumerations. | A series declared with one axis and a series declared with six both run. A value outside the declared set is refused at filing and named. 0 model calls for the proof. |
| **4** | The prompt stops naming a language. The declaration's text is appended in code, the way `AGENT_TOOLS_NOTE` appends mode text today (AGENTS.md rule 6). | The prompt audit's own rules still pass, and the planted-language check reports a Japanese name left in a prompt file. |
| **5** | Claims are filed **against an axis**, and the four collapse in §2.3 is undone. | A query answers "how formal is this character" without also returning their vocabulary. The coverage rules still count what they count today. |
| **6** | The voice revision door: file a replacement, mark the old row `superseded`, close its span. | A planted development in a fixture volume changes what the render calls current, and the old row survives byte-identical. Reuses `markSuperseded`; adds no new verb. |
| **7** | Confirmation gets a home, and "still holds" becomes an observation. | A second pass over the same fixture reports confirmations rather than new claims, and pays 0 calls for chapters it already read. |
| **8** | The render: current / arc / decision. | Compared against the rendered artifact that exists today, **before** anything is removed — the guard gotcha 120 records, which the author route's removal skipped. |
| **9** | **The closing cast reconciliation**, once, after the last volume: 0 model calls, a query over the record, three buckets — *named and voiced*, *named and never seen*, *on the page and nothing recorded*. The per-volume mention guard drops from a per-book stop to a per-book note, and the decision moves here. | The three buckets separate correctly on a fixture that contains all three. The middle bucket is **published as a named absence**, not reported as a failure. The third bucket is investigated only when the character is not fungible, by the §10.7 rule — recurrence across volumes, or named inside another character's speech — and a fungible miss is recorded and the run continues. Measured against this corpus: 179 recurring, 17 single-mention (§2.10), and the guard stops buying investigations for the tail. |
| **10** | The other six Japanese-named prompt files. | A separate program. Listed here so it is not forgotten, not scoped here. |

**Slice 0 is independent of this plan's design, and it is BUILT** (2026-10-14) — the voice reading
pass's own findings now reach the post-mortem, the ledger, the triage and the pause economics, at
0 model calls. Slices 1–9 are this plan.

**Slice 1 was not in the plan when it was written.** §2.9 found that the roster double-counts people and
that the door built to fold them reads a row the render route no longer writes. Every later slice asks
the record a question about *a character* — which facts belong to this chapter, which claims a
development replaced, whether this character was ever seen — and a roster that holds one person as two
entries makes each of those questions answerable twice, with different answers. It goes first.

**Slice 1 ran 2026-10-14, and its answer is the one the plan allowed for: no source states most of
these links in a form a door can file.** The numbers are §2.11. What slices 2 and 9 inherit from it is
recorded there too — most sharply that **no fact in any of the 17 records is keyed to a cast entry
today**, so slice 2's query has nothing to return and slice 9's guard has nothing to measure against
until the voice stage runs.

---

## 9. What this must never become

- **Not a model grading a declaration.** Whether a declared axis produced evidenced claims, whether a
  value is in the declared set, whether a character is present in the volume — all computable for free.
  A model asked to judge them is the mistake the extraction plan names outright.
- **Not a language list in code.** The moment a Japanese axis table appears in a `.js` file, the owner's
  decision has been reversed by convenience.
- **Not a second opinion on a published claim.** A development is filed as a replacement with evidence,
  not as a dispute. `disputed` is for disagreement, and the record already says so.
- **Not newest-wins.** The glossary's rule is that the latest volume's rendering is the law for the whole
  series, and that is right for a term's name. Applied to a character it would erase the arc and hand a
  translator of book 3 answers book 17 had not discovered yet. The voice record answers *"what holds as
  of this volume"*, and §5 is where that answer lives.
- **Not an edit.** No sealed row is edited, moved or deleted, ever. This is the rule the whole store is
  built on.
- **Not a bigger prompt.** The direction of every slice in this plan is to make what the chapters are
  shown *smaller and more relevant*, because the growth curve in §2.6 says the current shape is already
  being cut down on 16 of 17 volumes. A slice that makes the prompt larger has to arrive with a
  measurement that says why.

---

## 10. Open decisions for the account owner

1. ~~Is the declaration written by a model at intake, or proposed by a model and confirmed by a
   person?~~ **Answered 2026-10-14: the intake writes it, and nobody confirms it.** The account owner's
   reason is that the pipeline is meant to run unattended once started, and the axes are derived from
   the source language the intake already works out, so the inference is low-risk. **What that answer
   makes load-bearing:** the four computable guards in §4.3 are no longer a backstop behind a human
   review, they are the only review. In particular guard 3 — *an axis that produces no evidenced claim
   in a volume is reported* — is the signal that a wrong declaration was made, and its level in the
   seriousness table (§10.2) is now the decision that decides whether a bad declaration stops the run
   or is printed and walked past.
2. **Does an axis that no volume ever answers stop the run or warn?** It is a new kind in the seriousness
   table either way; the level is the decision. **This is now the live one**, because §10.1 removed the
   human review that would otherwise have caught a bad declaration.
3. ~~When is a register decision settled~~ — **Answered 2026-10-14: per volume.** The reasoning and the
   four mechanical consequences are in §6, including the one thing this plan must *not* copy from the
   glossary.
4. ~~Is a confirmation a row, or nothing?~~ **Answered 2026-10-14: a light confirmation row.** The
   reasoning is §5's — "still holds" should be an observation rather than an assumption — and the full
   claim row was rejected because it copies the same sentence once per volume and makes the coverage
   rules count one fact repeatedly. **Cost accepted:** a schema version bump, and a new row kind that is
   *not* a claim, so the renderers must keep excluding it from the bullets they publish.
5. **Does the declaration carry the point-of-view markers too**, or is that a separate declaration? They
   are language-specific for the same reason the pronouns are, and they are currently in the prompt.
6. **Does the second-person axis get a relationship in the record** — *who* is addressed this way — or is
   it a per-character claim? The schema has `fact_characters` with roles (`subject`, `agent`, `patient`,
   `witness`) and it is not used for this today.
 7. ~~How big a miss is worth an investigation~~ — **Answered 2026-10-14: fungible = recorded, not
    investigated; not fungible = investigated.** The computable stand-in the plan proposes is
    **present in 2 or more volumes, or named inside another character's speech**; both are readable from
    the record, and §2.10 shows this corpus splits 179 / 17 with no judgement call. **The known blind
    spot, accepted rather than hidden:** a character pivotal in exactly one volume and never mentioned
    again is classified fungible. The damage that misclassification does is bounded — the character is
    still named in the reference either way, so the error costs an investigation not run, not a hole
    hidden from the translator.
 8. **Does the roster get fixed before the coverage guard is asked to cover it?** §2.9 measured 196 cast
    rows, 0 alias declarations and 0 roster folds, with the glossary's own Notes saying that ジョーロ is
    如月雨露's nickname and ひまわり is 日向葵's. A guard that demands a voice entry per roster entry is
    demanding one per nickname, and the door built to fold them (`importGlossary` reading the glossary's
    pronoun row) reads a row the render route no longer writes. Fixing the roster is a prerequisite for
    the coverage question meaning anything, and it is not in this plan's slice list yet.
    **Measured 2026-10-14 by slice 1 (§2.11): the guard would indeed ask for a voice entry per
    nickname** — 35 groups hold 91 entries, 56 of them duplicates of another entry, and 105 entries
    are linked by nothing at all. **What is still the owner's decision is how to close it.** The only
    source that states links without being model-written prose covers 12% of the roster and does not
    say which entry a merge should keep; the source that covers 45% of it is prose, and the
    narrowest-looking shape for reading it was measured at 5 pairs, all 5 wrong. The options, and
    what each costs, are in `/tmp/opencode/roster-slice1-questions.md`. Slice 9 should be written so
    a nickname is a separate question from the person until one of those options is taken.

---

## 11. What this plan does not decide

Whether the style guide and the translation prompts should read the same declaration (§8 slice 8 lists
the files, not the answer). Whether a register axis can be revised mid-series by a person, or only by a
later volume's evidence. Whether the acceptance grader's rubric changes when the artifact's sections
change — it grades three files today, and a new section shape is a change to what it is grading.
