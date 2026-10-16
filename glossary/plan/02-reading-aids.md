# Plan 08 — the book's own reading aids become part of what the pipeline knows

Plan of record. Written 2026-10-16. Status: **slice 0 was BUILT (2026-10-16) and then DELETED the same day by
plan 09 slice 2** — the reading block reached the glossary read pass on both routes with 0 new model calls, and
plan 09 decision 3 removes it because the extracted chapter now carries every guide inline as
`<ruby>蒲田<rt>かまた</rt></ruby>`, so the block is a second copy of a fact the text already holds. **Its
measurements still stand** — they are what the corpus was priced with, and §5's verdict row is kept as the record
of them, with the deletion noted beside it. **Slices 1–4 are not built as this plan numbers them.** Plan 09 absorbs
them: its §5 says its **slices 3–5 are this plan's slices 1–3, re-numbered**, and its own slice 6 ("a published
translation never carries the markup") is the nearest thing to this plan's slice 4 but is **not** the same ask —
this plan's slice 4 re-opens the inline annotated view as a display option, and nothing in plan 09 does that. So
this plan's slice 4 is **absorbed in claim but not in fact**, and that gap is stated here rather than counted as
done. Where this plan and plan 09 disagree, plan 09 wins: `utils/source/plan/02-reading-aids-in-the-text.md`.

---

## 0. The decisions this plan is built on

**Decision 1 (the account owner, 2026-10-16) — keep every reading aid.**
An earlier answer treated the reading aids as mostly noise: the annotated view was scoped to "the renames
plus a guide the author applies every single time and the series uses at most twice", and the rest were
left out. That answer is **replaced**. Reading aids sometimes carry meaning, and which ones do is not
knowable in advance — it can change because of a narrative reveal, and it is heaviest in comedy. So:
**no reading aid is discarded.** A guide may be *displayed* selectively; it is never *unknown* to the
pipeline.

**Decision 2 (the account owner, 2026-10-16) — no closed status vocabulary.**
A proposal to give the glossary a `provisional / uncertain / expected-to-change` enumeration was
**refused**: language is fluid, models improve, and a vocabulary fixed today is a ceiling on legitimate
uses tomorrow. This repository has already made and undone that mistake once — the extraction's
`formalityLevel: polite | plain | honorific | humble | mixed` was deleted for naming one language's
concepts. Whatever this plan adds, the model writes **prose**, and the pipeline decides what to act on
by **querying recorded data**, never by asking the model to classify itself.

**Decision 3 (carried forward, unchanged) — meaning-carrying reference content stays in the source
language; nothing in the pipeline names a language.** Plan 06 §0 decision 1 and `test/test-no-language-axis-list.js`
still apply. Every rule below is computable from recorded facts, so it holds for Chinese, Korean,
Spanish, German or French books without a change.

---

## 1. The problem, in one paragraph

The converter strips pronunciation guides out of the chapter text (gotcha 123 — it stopped pasting
`蒲かま田た` for `蒲田`), which was correct, and nothing since then has put them back in front of the
model. So the pass that chooses a term's English wording sees bare spelling. In the one case in this
corpus where the book **answers the question outright** — it prints the reading over the name — the
pipeline threw the answer away, guessed from the kanji, guessed wrong, and later paid a revision call to
rediscover what was printed over the word since volume 3.

---

## 2. The measurements

All 0 model calls, 0 database opens, nothing written into `SERIES_LOCATION` (gotcha 124, gotcha 172).
Scripts: `/tmp/opencode/measure-reading-shift.js`, `/tmp/opencode/measure-reading-table-cost.js`.

### 2.1 The reading aids carry meaning, in these books, measurably

10,005 word-and-reading rows, 45,429 guided occurrences, 3,645 distinct written forms.

- **266 written forms are guided more than one way** series-wide; **160 of them are guided two ways
  inside the same volume.**
- **129 written forms are given a katakana reading over kanji spelling, 668 times.** These are not
  pronunciations:

  | Written | Guided as | Times | Volumes |
  |---|---|---|---|
  | 虹彩寺菫 | こうさいじすみれ (the ordinary reading) | 95 | 14–16 |
  | 虹彩寺菫 | **パンジー** (who she is) | **406** | 15–16 |
  | 三色院菫子 | さんしよくいんすみれこ | 289 | all 17 |
  | 三色院菫子 | **パンジー** | 18 | 9, 10, 15 |
  | 三色菫 | **パンジー** | 12 | 6, 10, 14, 15, 16, 17 |
  | 草見月 | **くさみルナ** | 10 | 4, 5, 7, 9, 11, 13, 14 |
  | 神 | **ブリキ** | 9 | 2, 4, 6, 10, 11, 12, 16 |
  | 世界の支配者 | **イラストレーター** | 8 | 2, 4, 6, 10, 11, 12, 16 |
  | 全知全能 | **オリンピア** | 5 | 9 |
  | 親友 | **サンちやん** / **ジヨーロ** | 5 | 4, 5, 16 |
  | 牡丹一華 | **アネモネ** | 6 | 8 |
  | 桜原桃 | **チエリー** | 5 | 11, 14, 16 |

  The author writes a **name** or a **meaning** over a word whose spelling withholds it. This is the
  shape the account owner named with 木村正義 → ジャスティス, and it is the dominant shape in this corpus.

- Comedy substitution is present: 三色院菫子 guided once as **おつぱい** and once as **お前** (volume 16);
  幼馴染 guided as **ひまわり** twice (volumes 4, 17); 唐菖蒲 guided as **ホーム** once (volume 14).
- Tone variation is present and is **not** information: 嫌 guided いや ×148 / きら ×115 / ぎら ×8;
  違 ちが ×284 / たが ×2; 頼 たの ×131 / たよ ×53; 逃 に ×133 / のが ×17; 怒 おこ ×115 / いか ×28.
- Ordinary variation is present: 美味 おい ×208 / うま ×113.

**The four shapes are distinguishable without asking the model**, because the tells are recorded facts:
is the reading itself a name the record already knows; is the reading an unrelated word guided rarely
over a whole phrase; are all the readings the same script with high counts and no name involved; are
there two ordinary readings spread evenly. That is a query over `written_forms`, which plan 07 slice 1
already built and which the corpus still holds **0** rows of.

### 2.2 The defect, stated as a number

**亜茶花.** The book guides it as **あさか 32 times, in volumes 3, 7, 9, 13, 14 and 16.**
Volume 3 published it as **"Atsuka"** with the note *"the reading was inferred"*.

- In volume 3's extracted text the term appears **exactly once**, in chapter **ch7.1**.
- Chapter ch7.1 is **where the book guides it あさか**. That chapter guides **133 words**.
- The extracted chapter files contain **0 `<ruby>` markup** — the reading was removed before the model
  ever saw the line.

Volume 14 later "discovered" the reading from hiragana in dialogue and filed a revision. The pipeline
paid to find an answer it had already been given.

Also measured, same probe: 有不和 → あるふわ ×43 across 8 volumes (the real surname behind the α君 / β君
placeholders); 蒲田 → かまた ×5.

### 2.3 What showing them costs, priced three ways

133 chapters, 2,450,316 characters of extracted text.

| Shape | Added characters | Share | Notes |
|---|---|---|---|
| **A** — inline ruby over every guide | **+999,444** | **40.8 %** | estimated: the harvest records a pair's count for the whole volume and the chapters it appears in, so the per-chapter share is `count / chapters` (the extracted text records no guide positions — gotcha 171) |
| **B** — a per-chapter reading table, **every** guide, one line each | **+208,513** | **8.5 %** | 18,905 lines; median 1,066 chars per chapter, p90 3,758, max 5,585 |
| **C** — only the reveal-shaped guides | +3,098 | 0.13 % | 218 lines, in 80 of 133 chapters |

Guided pairs per chapter: min 2, **median 93**, p90 346, **max 511**. Chapter text: median 20,605, max 47,930.

**B is the shape this plan builds.** It satisfies "keep every reading aid" — nothing is filtered — at a
tenth of inline markup's cost, and it is a table the model reads rather than markup it has to parse.

### 2.4 What already exists and is wired to nobody

Plan 07 slice 5 built the annotated inline view (`utils/reference-store/written-forms/view/`:
`select.js` 329, `render.js` 220, `chapter.js` 112) and the strip rule (`utils/reference-store/ruby-markup.js`),
and taught both markdown parsers the markup. It has **0 callers outside its own layer** — no stage shows
an annotated chapter to the model today. Its selection rule (one reading in that volume, guided as many
times as the volume prints it, guided no more than twice there) is **Decision 1's old answer**, and it
selects 4,497 (volume, form) pairs out of 9,663. Under Decision 1 that rule is a **display** choice, not
a knowledge rule, and it must stop being the gate on what the pipeline knows.

`written_forms` (plan 07 slice 1) already files **every** harvested row passing the two row guards —
8,910 rows / 41,710 occurrences on copies of the 17 records — and is out of `UPDATABLE_FIELDS` and in
`COUNTED_TABLES`. The table is the right home; the corpus simply has 0 rows in it because no real run has
populated it.

`fileVolumeWrittenForms` is **the only door in this store allowed to open `<base>-ruby-guides.json`**.
Any new reader of the harvest must go through it or that invariant is gone.

**Measured again on 2026-10-16 while slice 0 was built, and the sentence is narrower than it reads:**
`readRubyGuideFile` (`utils/source/ruby-guides.js`) — the **reader function** — already had three callers
outside the store (`glossary/re-render/record.js`, `utils/source/guide-groups.js`, and since slice 0
`glossary/extract/reading-block.js`). What the invariant actually protects is the **store**: no second door
*inside `utils/reference-store/`* opens a harvest file, and that is pinned at exactly one
(`written-forms/file.js`) — **by `test/test-written-forms.js` scenario 12 since plan 09 slice 2 deleted
`test/test-glossary-reading-block.js`, whose scenario 10 was the pin before it** (the scan moved rather than
going with the suite, because deleting a suite must not delete a guard). The stage's own reading pass read the
harvest directly because it was reading the book, not filing a row — the same direction
`written-forms-cannot-look-forward` enforces on the filing door. **That stage-side reader is gone** (plan 09
slice 2): the chapter text carries the guides, so the glossary read pass no longer needs the harvest at all, and
the two remaining readers outside the store are `glossary/re-render/record.js` and `utils/source/guide-groups.js`.

### 2.5 What slice 0 actually costs, and where the cap sits (measured 2026-10-16)

`/tmp/opencode/measure-reading-block-cap.js` (the table), `/tmp/opencode/measure-reading-block-ladder.js`
and `/tmp/opencode/measure-reading-block-wire-cost.js` (both running the **shipped builder** against the 17
real harvests) — 17 real volumes, 133 chapters, **0 model calls, 0 database opens**, nothing written into
`SERIES_LOCATION`. The last two exist because the first one under-reported the cost, and the way it did it
is the lesson.

§2.3's shape B was re-measured and reproduces exactly (**18,905 lines, +208,513 characters, 8.51 %**). The
shipped shape is one line per **written form** with its readings joined by ` | `, not one line per
(word, reading) pair, so multiplicity sits on one line: **18,567 lines / 207,006 characters, 8.45 %** —
338 fewer lines, 1,507 fewer characters. Per chapter: min 2 lines, **median 92**, p90 342, **max 503**; the
most readings on one line is **4**; the longest single line is 38 characters.

**A table line is not the block, and the difference is 4.6 percentage points.** The builder also prints a
heading and two guidance paragraphs — **815 characters** — plus a `### <chapter>` line per chapter on a
multi-chapter block, and on the chapter-by-chapter route that preamble is paid **once per chapter, 133
times**. Measured through the shipped builder at the shipped cap, against 2,450,316 characters of extracted
text:

| Route | Blocks | Table lines | Heading + guidance | **On the wire** |
|---|---|---|---|---|
| chapter-by-chapter (`--chunked=glossary`) | 133 | +203,721 (8.31 %) | +111,925 (4.57 %) | **+315,646 (12.88 %)** |
| whole-installment (the default) | 17 | +203,721 (8.31 %) | +16,911 (0.69 %) | **+220,632 (9.00 %)** |

Per chapter on the chapter-by-chapter route the block is **median 1,891 characters, p90 4,570, max 5,667**
against a chapter whose text median is 20,605 — a **9.2 %** growth on the median chapter. The first number
in this section's earlier draft (8.45 %) was the **table only**; it is the right number for the table and the
wrong number for the call, and §2.3's 8.5 % projection is a projection of a table, not of a request.

**The cap ladder** (`READING_BLOCK_MAX_LINES`, a constant with no environment knob). Lines are what the cap
governs; the wire column is the same builder at the same cap:

| Cap | Chapters truncated | Lines dropped | Lines shown | Table only | On the wire (133 chapter calls) |
|---|---|---|---|---|---|
| 100 | 54 of 133 | 8,436 (45.5 %) | 10,131 | +112,555 (4.59 %) | +238,072 (9.72 %) |
| 250 | 27 of 133 | 2,830 (15.2 %) | 15,737 | +173,956 (7.10 %) | +291,038 (11.88 %) |
| **400 (shipped)** | **5 of 133** | **288 (1.6 %)** | **18,279** | **+203,721 (8.31 %)** | **+315,646 (12.88 %)** |
| 600 | 0 | 0 | 18,567 | +207,006 (8.45 %) | +315,401 (12.87 %) |
| unbounded | 0 | 0 | 18,567 | +207,006 (8.45 %) | +315,401 (12.87 %) |

The 5 chapters 400 bites on are volume 03 ch1 (503 lines), volume 03 ch3 (415), volume 03 ch4 (473),
volume 04 ch1 (435) and volume 05 ch2 (462) — each one named, with its own count, in the block it was cut
from. 600 is the first number in the ladder that cuts nothing, so **400 is a deliberate 1.6 % trim, not a
bound the data forced**; the choice is §6 item 5 and the constant is where it lives.

**Per chapter rather than merged per volume, and the measurement is why.** A merged whole-volume table —
one line per written form for the whole book, the shape the whole-installment route would naturally use — is
**9,663 lines / 111,923 characters (4.57 %)** unbounded, less than half the per-chapter 18,567 / 207,006,
because a form a volume guides in three chapters is printed once instead of three times. But it is not what
the shipped volume route emits (that route prints the volume's chapters as **sections**, so it shows the same
18,279 lines and pays only the preamble fewer times), and at a cap of 400 a merged table truncates **6 of 17
volumes** and drops **4,130 lines**, against **288 lines across 5 of 133 chapters** for the same cap applied
per chapter. The whole-installment route therefore shows the volume's guides **chapter by chapter, each
chapter under the same per-chapter cap**, which is also the only shape that attributes a reading to the
chapter it was printed over.

**The floor line costs 416 characters per call.** A volume with no harvest on disk (the offline loop
fixtures, and any book extracted before the harvest existed) still gets its block: the heading, the sentence
naming which fact that is, and the count. Measured in both offline loops' `pass-1-glossary.log`.

---

## 3. What this replaces, and what it leaves alone

| Stays | Changes |
|---|---|
| The converter extracts guide-free text (`蒲田`, not `蒲かま田た`) — gotcha 123 | The guides reach the model **as a separate block**, not pasted into the words |
| `written_forms` files every row passing the row guards | It becomes **read** by the stage that files terms, not just filed |
| The glossary's `note` is written in the language of the book (plan 07 slice 7) | The terminology review's forward half stops depending on reading prose in a language it may not know |
| The 15 English forward-reveal shapes | They become the **legacy** path for records published before a reading is recorded, and the coverage report says which half did the work |
| The revision door (a later volume files a new row quoting its own text) | It must stop assuming **newer = better** when what changed is how a name is *spoken* |
| The annotated inline view and its ≤2-uses display rule | It becomes a display option, not the gate on what the pipeline knows |

---

## 4. The design

### 4.1 The reading block

For each chapter, beside the chapter text, a compact table of **every** guide the book puts over a word
in that chapter, taken from the volume's own harvest:

```
## Readings the book itself prints in this chapter
2 line(s) shown.
  亜茶花 → あさか
  有不和 → あるふわ
  虹彩寺菫 → こうさいじすみれ | パンジー
  三色院菫子 → さんしよくいんすみれこ | パンジー
```

Rules:
- **Every** guide is eligible. Nothing is filtered by rarity, script or "looks meaningful".
- A word guided several ways prints all of them on one line — the multiplicity **is** the signal.
- A bound exists on how many lines are *shown*, and the lines it drops are **named**, in the same shape
  `character-voice/known-facts.js` uses (plan 06 slice 2): a cap that silently truncates is a cap that
  hides the case it truncated.
- It is built from the volume's own harvest, through the one door that may read it.
- It costs 0 model calls and is not a new prompt kind.

**As built (slice 0, 2026-10-16).** `glossary/extract/reading-block.js`. The line is one **written form**
with its readings joined by `" | "`; the order is the harvest's own row order (count descending, then the
form, then the reading), so the cap cuts the single-occurrence tail rather than an arbitrary slice, and no
judgement about which guides matter is made here. `READING_BLOCK_MAX_LINES` (400),
`READING_BLOCK_NAMED_OMITTED` (12) and `READING_BLOCK_NOTE_MAX_CHARS` (900) are constants with no
environment knob; the announcement names 12 of what it dropped and counts the rest, and is itself bounded so
a bound cannot be walked past by the line reporting it. The harvest is read **once per volume** and reused
across that volume's chapters (`loadReadingAids` memoises on `ctx.readingAids`). Four states are four
different sentences, and none of them is an empty string: `read`, `no-harvest-in-source` (a plain-text book),
`harvest-file-missing` (a book extracted before the harvest existed, or one whose file was moved), and
`no-source-base` (a bundle that names no base, so no harvest file can be named). A chapter with nothing to
show gets a floor line saying the volume prints guides elsewhere. The block reaches the model as its **own
`{ text: … }` message** beside the chapter file — the shape `character-voice/stages.js` uses for the
known-facts block — and **not** as text appended to the shared system prompt, which is for per-series role
text (AGENTS.md rule 6). `system-prompts/glossary-terms.md` is byte-identical, pinned by digest in the suite.

### 4.2 The reading is recorded on the term

When a term is filed, the record also holds **what the book guided for that written form in that volume**,
as its own insert-only row beside the term — never a column edit on the published row, in the shape
`claim_confirmations` uses (plan 06 slice 7): the term row is never touched.

This is what makes the next half possible without any text matching.

### 4.3 "The reading changed" is a query

The forward half of the terminology review becomes:

> Which recorded terms have a written form whose **guide differs between volumes**, and which of those
> differences arrived in a later volume?

Language-free. 0 model calls to *find* the candidates. The bounded reading calls are then spent only on
candidates the book itself raised. On this corpus that is **266 written forms**, of which the
name-substitution class is **129** — against a bound of 24 calls per run, so the agenda needs a ranking
rule, and the ranking is the interesting design question (which differences matter most), not a
vocabulary.

### 4.4 The revision door must stop assuming newer is better

Today a revision is filed when a later volume quotes a line of its own text. That guard stops a
fabrication. It does **not** stop a misreading.

A name that characters deliberately mangle for a running joke — the 佐藤和真 → "Kuzuma" shape — looks
identical to a correction. So:

- a revision that changes **how a name is spoken** is checked against the recorded guides before it
  settles;
- a variant the book guides **repeatedly** is named as a variant, not corrected;
- the correction is not deleted — it is recorded as what a later volume chose, beside what the book
  guided, and the disagreement is printed.

---

## 5. The slices, in build order

| # | Slice | Acceptance line |
|---|---|---|
| **0** | **BUILT (2026-10-16), then DELETED the same day by plan 09 slice 2.** **The reading block reached the glossary read pass.** Built from the volume's own harvest, through the one door that may read it. Every guide eligible; a named cap with the remainder printed. | A fixture chapter whose book guides a word two ways showed both to the model, and a fixture where the guide answers a reading the extraction would otherwise guess showed the guide, not the guess. **0 new model calls**; both offline loops' call counts unmoved; the `glossary-extract` prompt size measured before and after against the 8.5 % projection; the harvest still had exactly one reader in the store. **Met except one clause, and that clause is the lesson:** the acceptance line asked for the size "measured against the 8.5 % projection", and the shipped block was **12.88 %** on the chapter-by-chapter route — §2.3's 8.5 % was a projection of a **table**, and the block was a table plus a heading and two guidance paragraphs paid once per chapter. See §2.5 and gotcha 175. **Why it was deleted:** plan 09 decision 3 — the extracted chapter now prints every guide inline as `<ruby>…<rt>…</rt></ruby>`, so the block is a second copy of a fact the text carries, and two copies of one fact are two things that can disagree. |
| **1** | **The reading is recorded beside the term.** Insert-only row, `COUNTED_TABLES`, copy-forward carries it, the published term row is never edited. | Filing a term that the book guided records the guide; a term the book never guided records nothing and says so; a second pass files 0; every content column of the term row compared and unmoved. `SCHEMA_VERSION` 13 → 14 and the pinned table-counting suites moved deliberately, with the reason written (gotcha 170). |
| **2** | **"The reading changed" becomes the forward half of the review.** A query over the recorded guides, ranked, bounded by the existing 24-call bound. The 15 English shapes stay as the legacy path and the coverage report names which half produced the agenda. | On copies of the 17 records, 0 model calls: the query finds the measured 266 / 129 classes and ranks them inside the bound; a fixture where a later volume guides a form differently puts that term on the agenda with **no phrase matching at all**; a series whose records predate the field still gets the legacy half and reports it as legacy. |
| **3** | **The revision door stops assuming newer is better** for a change in how a name is spoken. | A planted revision that contradicts a guide the book prints repeatedly is **named, not settled**; a planted genuine correction still settles; both outcomes print the guide and the choice side by side; 0 published rows edited. |
| **4** | **The inline annotated view re-opened under Decision 1.** Its rarity rule becomes a display option; the record keeps everything. | The view can annotate every guide in a chapter (the 40.8 % cost measured and printed), and the shipped display mode is chosen with that number in front of it; `stripRubyMarkup(annotate(text)) === text` still holds on all 133 real chapters. |

Slices 0 and 1 are the ones that would have prevented "Atsuka". Slice 2 is the one that retires the
phrase-list question. Slice 3 is the one that stops the pipeline erasing a joke. Slice 4 is the one the
account owner's Decision 1 formally re-opens.

### Slice 0 — the verdict (measured 2026-10-16)

**Superseded the same day.** The code this table measured is **gone** — plan 09 slice 2 deleted
`glossary/extract/reading-block.js` (441 lines), its suite (794 lines), the **12** names `glossary/extract.js`
re-exported from it (the row below said 13; the barrel held 12) and its **three** call sites
(`glossary/chunked.js`, `glossary/task.js` `extractNewTerms`, `glossary/task.js` `dumpVolumePreview` — the row
below counted two; the dry-run section is the one it missed). **The measurements are kept as measurements**: they
are the numbers the corpus was priced with, and the lesson in the last two rows is not specific to the block. The
harvest-access pin moved to `test/test-written-forms.js` scenario 12. Plan 09's own account is
`utils/source/plan/02-reading-aids-in-the-text.md` §2.8.

| Claim | Measured |
|---|---|
| The code | `glossary/extract/reading-block.js` (441 lines), reached from `glossary/chunked.js` (chapter-by-chapter route) and `glossary/task.js` (whole-installment route), plus `glossary/task.js` `dumpVolumePreview` (the `--dry-run` section); `glossary/extract.js` re-exported **12** names from it. **All deleted by plan 09 slice 2** |
| A two-way guide reaches the model on one line | `test/test-glossary-reading-block.js` scenario 1 — `虹彩寺菫 → こうさいじすみれ \| パンジー` on the wire. **The suite is deleted**; the shape it pinned is now the chapter text's own markup |
| The guide beats the guess | Scenario 2 — `亜茶花 → あさか` is on the wire, with the prompt's own "the guide is not the word" rule beside it |
| 0 new model calls | Main offline loop **82 requests / 17 kinds** (was 82 / 17), chunked loop **28 / 6** (was 28 / 6), **0 on the second pass in both**; prompt audit **23 checks, 0 findings** — **and still exactly these numbers after the deletion** (plan 09 §2.8) |
| Prompt size, before and after | `glossary-extract` **12,114 → 12,530** (main) and **12,391 → 12,807** (chunked). Every other kind unmoved. The move is the **416-character floor line**, not a real block: the offline fixtures' books are plain text with no harvest, so the block's real size is **not observable in the loops at all** — it is measured against the 17 real books through the shipped builder instead (**+315,646 characters, 12.88 %** on the chapter-by-chapter route, **+220,632, 9.00 %** on the whole-installment route; §2.5). **After the deletion: 12,485 / 12,762** — below the table era, **not** back to 12,114 / 12,391, because the prompt rule that replaces the table costs **+371 characters** |
| The harvest still has one reader in the store | Scenario 10 pinned `utils/reference-store/**` at exactly one file that opens a harvest (`written-forms/file.js`) — **now `test/test-written-forms.js` scenario 12**. **The acceptance line's wording is narrower than the fact**: `readRubyGuideFile` had three callers outside the store (see §2.4); it has **two** now |
| The corpus is untouched | 17 record digests identical to the pinned baseline, **34 / 34** write-ahead sidecars still present, 0 database opens by this slice |
| Nothing else moved | `SCHEMA_VERSION` **13**, `COUNTED_TABLES` **21**, level table **70 kinds** (72 since plan 09 slice 1), freeze doors **12**, 0 new commands, 0 new prompt files, 0 new settings or knobs, `system-prompts/glossary-terms.md` byte-identical (pinned by digest) — **the prompt is no longer byte-identical**: plan 09 slice 2 rewrote its rule 3 to teach the markup |
| What did move, and why | `test/test-module-layer.js` **417 → 424** checks and **60 → 63** nested layer files (one new file inside a layer scanned three times); `test/test-no-language-axis-list.js` scans **459 → 460** pipeline files, **81 checks, 0 findings**. **Both moved back on the deletion: 424 → 417 checks, 63 → 60 nested files, 460 → 459 files** — the same three-times-counted layer, in reverse |


---

## 6. Open decisions, for the account owner

**Items 1, 5 and 9 are moot as written** — they are questions about the per-chapter reading block, and plan 09
slice 2 deleted it on 2026-10-16 (the chapter text carries the guides now). Item 1's real question survives in a
different form: plan 09 §6 item 4 asks whether the **translation stage is shown the markup at all**, and the
character-voice stage already reads annotated text. Items 5 and 9 have no subject: `READING_BLOCK_MAX_LINES` no
longer exists, and there is no block to truncate or record. The rest are open, and plan 09 §6 is where the live
list is.

1. **Does the reading block go to the character-voice reading pass and the translation stage too**, or
   only to the glossary? The voice stage reads chapter by chapter and the translator reads the chapter;
   both currently see guide-free text. Cost is the same block per chapter — **12.88 %** of the chapter text
   on the chapter-by-chapter shape (§2.5) — paid a third time in each stage that takes it.
2. **May a guide refuse a filing** — a term filed with a wording that contradicts what the book prints
   over it — or is a disagreement only ever reported? Refusing is stronger and is the first place this
   pipeline would decline to file something the model chose.
3. **Does the recorded reading reach the published `glossary.md`** (a fourth column, which rewrites 17
   published files and therefore meets the freeze gate), or only the run's own reports?
4. **Is the inline ruby view ever published**, at 40.8 % of the text, or kept as a run-side aid?
5. **The cap on the per-chapter block.** Shipped at **400 lines** (`READING_BLOCK_MAX_LINES`, no knob).
   Measured against the 133 real chapters (§2.5): 400 truncates **5 chapters and 288 of 18,567 lines
   (1.6 %)**; **600 truncates nothing**; 250 truncates 27 chapters and 2,830 lines; 100 truncates 54 and
   8,436. So 400 is a **deliberate 1.6 % trim, not a bound the data forced** — the first number in the
   ladder that cuts nothing is 600, and it costs **1,676 more characters across the whole series**
   (3,285 table characters added against 1,609 characters of truncation note removed: 315,646 at 400,
   317,322 at 600, both 12.9 %). The number is still the account owner's to change; the constant is where
   the decision lives.
6. **How the reading-shift agenda is ranked** when 266 candidates meet a 24-call bound: by the reading
   being a known name, by how many volumes disagree, by how often, or by the term already being on the
   chain half.
7. **Whether the 17 existing records are re-derived** so they carry readings, or the legacy phrase path
   stays their only forward half until a real run populates the new rows.
8. **Whether the count rides on the line.** The shipped line is `虹彩寺菫 → こうさいじすみれ | パンジー` with
   no frequency. The plan's own headline case is 虹彩寺菫 guided 95 times one way and **406** the other, and
   the noise case is 嫌 guided いや ×148 / きら ×115 / ぎら ×8 — a count is the difference between "this word
   has four readings" and "one of them is what the author actually writes", and it is already in the harvest.
   Adding `×406` costs about 6 characters a line (≈111,000 across the series) and is a judgement about what
   the model should be told to weigh, so it is not made here.
9. **Whether a truncated block is recorded durably.** Today the count and the named remainder are in the
   block the model sees and in the volume's console log. They are **not** in `extractionReadReport`, which
   the acceptance grader reads, and not in any record row — so a run's report cannot be asked afterwards
   "which chapters were shown only part of the book's annotations". Putting it in the read report moves a
   grader's prompt; putting it in a row is slice 1's territory. Neither was done here.

---

## 7. What this must not become

- **Not a model grading itself.** No status enumeration, no self-reported confidence, no "flag this if
  provisional". The model writes prose; the pipeline asks the record questions.
- **Not a filter that decides which annotations matter.** Eligibility is "the book printed it". Ranking
  decides what to *ask about*, and the unasked ones are named.
- **Not a second Notes column.** The Notes cell is what the book says; the reading block is what the book
  says over the words; neither is where the pipeline's doubts go.
- **Not a rewrite of a published artifact.** A new row beside a term, never an edit of one, and the
  freeze gate is asked before anything published is touched.
