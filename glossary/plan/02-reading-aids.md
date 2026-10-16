# Plan 08 — the book's own reading aids become part of what the pipeline knows

Plan of record. Written 2026-10-16. Status: **nothing built yet.**

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
Readings the book itself gives in this chapter (346 of 511 shown; 165 named and left out):
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
| **0** | **The reading block reaches the glossary read pass.** Built from the volume's own harvest, through the one door that may read it. Every guide eligible; a named cap with the remainder printed. | A fixture chapter whose book guides a word two ways shows both to the model, and a fixture where the guide answers a reading the extraction would otherwise guess shows the guide, not the guess. **0 new model calls**; both offline loops' call counts unmoved; the `glossary-extract` prompt size measured before and after against the 8.5 % projection; the harvest still has exactly one reader in the store. |
| **1** | **The reading is recorded beside the term.** Insert-only row, `COUNTED_TABLES`, copy-forward carries it, the published term row is never edited. | Filing a term that the book guided records the guide; a term the book never guided records nothing and says so; a second pass files 0; every content column of the term row compared and unmoved. `SCHEMA_VERSION` 13 → 14 and the pinned table-counting suites moved deliberately, with the reason written (gotcha 170). |
| **2** | **"The reading changed" becomes the forward half of the review.** A query over the recorded guides, ranked, bounded by the existing 24-call bound. The 15 English shapes stay as the legacy path and the coverage report names which half produced the agenda. | On copies of the 17 records, 0 model calls: the query finds the measured 266 / 129 classes and ranks them inside the bound; a fixture where a later volume guides a form differently puts that term on the agenda with **no phrase matching at all**; a series whose records predate the field still gets the legacy half and reports it as legacy. |
| **3** | **The revision door stops assuming newer is better** for a change in how a name is spoken. | A planted revision that contradicts a guide the book prints repeatedly is **named, not settled**; a planted genuine correction still settles; both outcomes print the guide and the choice side by side; 0 published rows edited. |
| **4** | **The inline annotated view re-opened under Decision 1.** Its rarity rule becomes a display option; the record keeps everything. | The view can annotate every guide in a chapter (the 40.8 % cost measured and printed), and the shipped display mode is chosen with that number in front of it; `stripRubyMarkup(annotate(text)) === text` still holds on all 133 real chapters. |

Slices 0 and 1 are the ones that would have prevented "Atsuka". Slice 2 is the one that retires the
phrase-list question. Slice 3 is the one that stops the pipeline erasing a joke. Slice 4 is the one the
account owner's Decision 1 formally re-opens.

---

## 6. Open decisions, for the account owner

1. **Does the reading block go to the character-voice reading pass and the translation stage too**, or
   only to the glossary? The voice stage reads chapter by chapter and the translator reads the chapter;
   both currently see guide-free text. Cost is the same 8.5 % per chapter, three times.
2. **May a guide refuse a filing** — a term filed with a wording that contradicts what the book prints
   over it — or is a disagreement only ever reported? Refusing is stronger and is the first place this
   pipeline would decline to file something the model chose.
3. **Does the recorded reading reach the published `glossary.md`** (a fourth column, which rewrites 17
   published files and therefore meets the freeze gate), or only the run's own reports?
4. **Is the inline ruby view ever published**, at 40.8 % of the text, or kept as a run-side aid?
5. **The cap on the per-chapter block.** Today: median 93 pairs, p90 346, max 511. A cap that names what
   it dropped is required either way; the number is a judgement about how much of the model's attention
   to spend on the book's own annotations.
6. **How the reading-shift agenda is ranked** when 266 candidates meet a 24-call bound: by the reading
   being a known name, by how many volumes disagree, by how often, or by the term already being on the
   chain half.
7. **Whether the 17 existing records are re-derived** so they carry readings, or the legacy phrase path
   stays their only forward half until a real run populates the new rows.

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
