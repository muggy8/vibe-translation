# Plan 07: written forms, relations, and a voice record that never looks forward

**Status: direction approved by the account owner 2026-10-15, and the owner's five answers are recorded in
§2b. Slice 0 is BUILT (2026-10-15)** — the reader `utils/source/guide-groups.js`, its fixture suite
`test/test-guide-groups.js` (94 checks), and the re-measurement `test/measure-guide-groups.js` (0 model
calls). **Slice 1 is BUILT (2026-10-15)** — `utils/reference-store/written-forms/` behind its cover, schema
12, `test/test-written-forms.js` (**211 checks**) in `npm test`, `test/measure-written-forms.js` beside it.
**Slice 2 is BUILT (2026-10-15)** — the identity door reads the record's own written-form rows through
`candidateGroupsInRecord`, §2.9's roster-or-reading rule replaces the rule that required both sides to be
roster names, and the fold table gained the one missing entry; `test/test-identity-table.js` (**166 checks**)
and `test/test-identity-table-isolation.js` (**547 checks**) in `npm test`, `test/measure-identities.js`
beside it. **Slice 2b is BUILT (2026-10-15)** — two deterministic reports in the written-forms layer
(`written-forms/reports/`), 0 model calls, filing nothing, `test/test-source-quality-reports.js`
(**179 checks**) in `npm test` and `test/measure-source-quality.js` beside it; the anomaly class narrowed to
the one discriminator that fires on the real defect and on nothing else, because the shape this plan first
named fires **309 times** and four of those are the spelling §2.11(b) withdrew. **§2 is that re-measurement,
and it corrects three numbers the plan was written with** (§2.2, §2.3, §2.7), **then two more the correction
itself got wrong** (§2.11), **then the acceptance line slice 1 was dispatched against, which turned out to ask
for two mutually exclusive things** (§2.13), **and then the shape slice 2b was dispatched against, which turned
out to contradict §2.11(b)** (§4.9). **Slice 3 is BUILT (2026-10-15)** — `utils/reference-store/relations/`
behind its cover, schema **12 → 13**, `relations` in `COUNTED_TABLES` (20 → 21), the door files an act of
address keyed on identities and closes a span only with a line the closing volume prints, 0 model calls,
unwired, `test/test-relations-table.js` and `test/test-relations-isolation.js` in `npm test` and
`test/measure-relations.js` beside them (those two suites now stand at **265** and **205** checks — slice 4
moved them, see below). **Slice 4 is BUILT (2026-10-15)** — the extraction contract: an act of address is a
fourth kind in the chapter call that already runs, its certainty computed by code through the §4.4 ladder,
filed by `utils/reference-store/relations/contract.js` through the door slice 3 built, from one producer
outside the layer (the rebuild door), at **0 extra model calls** and with no new table, level, door, command,
setting or knob; `test/test-relation-contract.js` (**144 checks**) joins `npm test`. **Slice 5 is BUILT
(2026-10-15)** — normalise, teach, then show: `utils/reference-store/ruby-markup.js` is the store's one rule
about HTML ruby and its tag vocabulary is pinned against the converter's, the strip is wired into
`normalizeQuote` / `quoteSkeleton` so every citation door compares guide-free text and reports
`markupStripped`, the markdown parsers are taught before any published file may carry the markup
(`annotatedLines`, `annotatedRows`, strip-before-split in both glossary readers), and only then the view —
`written-forms/view/` (`select.js` / `render.js` / `chapter.js`), at **0 model calls**, **0 callers outside its
layer**, and with no new table, level, finding kind, freeze door, command, setting or knob.
`test/test-annotated-view.js` (**203 checks**) joins `npm test` and `test/measure-annotated-view.js` beside it.
**§5's slice-5 verdict records that the acceptance line's own numbers do not reproduce** — the shipped door
selects **4,497 pairs / 5,546 occurrences / +145,054 characters**, not §2.12's 4,808 / 6,739 / +192,251 — and
names the three reasons, every one of them printed by `test/measure-annotated-view.js`, which recomputes
§2.12's four rows from the 17 harvests and **fails its own run** if row 2 stops reproducing 4,808 / 6,739.
**Slices 6–7 are not built.**
**§6.7 is answered (2026-10-15): the door files
every harvested row that passes the two row guards and the group question is answered by query**, which slice 1
now does, and **slice 2 is built on it**.

This plan supersedes parts of `06-register-declarations.md` and says so plainly where. Plan 06 built
the record machinery — declarations, per-question answers, the revision door, confirmations, the closing
cast reconciliation — and every one of those slices had to be proven against fixtures because the corpus
holds no voice claims at all. This plan supplies the thing plan 06 was missing: **a way to know which
name is which person**, which is the floor under all of it.

---

## 0. The decisions this plan is built on

All taken by the account owner on 2026-10-15, in the conversation that produced this plan.

1. **A glossary column heading names no language.** The published table is headed `Japanese | English |
   Notes` today. It becomes a pair of role names — *the source* and *the target* — so the labels survive a
   language change.
2. **Meaning-carrying output is written in the source language.** Notes, quotes, descriptions and claim
   bodies stay in the language of the book. Only two things are in the target language: the chosen
   rendering, and the machine keys the code reads. The reason is the owner's: every switch between
   languages loses something, so the pipeline should switch as few times as possible, and the glossary is
   the stage where a loss is hardest to undo.
3. **Prompt files are not translated into the source language.** The owner proposed a step that would
   translate the prompt templates so the model reasons in the source language; the pushback — a translated
   prompt is a model-authored rewrite of the pipeline's rules, half of every prompt is a machine contract,
   and it collides with the rule that no prompt names the language of its own work — was accepted. The
   gain is taken from the *outputs* instead.
4. **The stored text stays guide-free.** Pronunciation guides are not pasted back into the words they
   annotate. They reach the model as a **view**, marked up in HTML `<ruby>`, limited to the forms that
   actually carry meaning.
5. **A quote is normalised before it is checked.** The reading is stripped out of a quote before it is
   compared against the book, and the markdown parsers are taught to survive ruby markup **before** ruby
   markup is allowed into any published file.
6. **Character facts move to a relations model.** Who addresses whom, in which written form, over what
   span — a row, not a sentence in a document.
7. **Voice never looks forward.** Each volume's record is a copy of the previous volume's plus its own,
   and a volume's translation reads *that volume's* record. The glossary deliberately does the opposite:
   terminology is expected not to change, so the newest rendering wins. **This asymmetry is the owner's
   rule and it is already built; this plan keeps it and pins it.**
8. **Closing a span records why.** A span closed by a later volume carries which volume closed it, which
   chapter, and the line that showed it. `valid_to` without a reason is a quiet rewrite.
9. **"Unknown speaker" and "the author withheld it" are legal answers**, not failures. The second is a
   fact with translator value: *this line's speaker is hidden on purpose — do not resolve it.*
10. **Certainty is derived from what the record can measure**, not from a number the model reports about
    itself.
11. **An alias is a statement, never a merge.** Filing "this form is another way of writing that one" is
    safe; moving a claim from one person to another because a rule inferred it is not.
12. **No paid runs while the shape is moving.** Every slice in this plan is provable with 0 model calls.
    The clean full pre-production run — which is where the notes-language change actually lands — happens
    once pre-production is implemented and refactored, on the owner's timing.

---

## 1. The problem, in one paragraph

The reference records hold 196 cast entries for roughly 35 people, and nothing in them says which entry is
which person. Every slice built on top of that — coverage, per-chapter queries, revision, confirmation,
reconciliation — is answering a question about *names* while meaning a question about *people*. The
plan-06 identity table groups names, but it was measured to find almost nothing, and it is wired into
nothing. Meanwhile the extraction has been writing, beside every volume, a file that records what the
author actually did with names, and nothing reads it. That file is the floor this plan needs.

---

## 2. The measurements

Every number in §2 was re-run on 2026-10-15 by `test/measure-guide-groups.js`: 0 model calls, reads only
the harvest JSON and the published markdown, opens a **copy** of one record (gotcha 124), writes nothing,
and fails its own run if any `series.db` digest or `-wal` / `-shm` sidecar moved. The reader it measures
is `utils/source/guide-groups.js`, and `test/test-guide-groups.js` (94 checks, fixtures only) is what
pins its rule — a test may not read the 17 real volumes (AGENTS.md rule 8), so the numbers live here and
the rule lives in the fixture.

### 2.1 The guide file is already there, and it is big

Every volume's extraction writes `<base>-ruby-guides.json` beside its text: one row per word-and-reading
pair, with how many times it occurs, which chapters, which script, and the per-annotation sequence of
which base character carried which reading. Measured across all 17 volumes, 0 model calls:

| | |
|---|---|
| files | 17 |
| distinct word-and-reading rows | **10,005** |
| total occurrences | **45,429** |
| characters of reading text | 34,355 |

### 2.2 The candidate set, and the display subset that is not the rule

Two different subsets were measured, and the plan originally recorded only the narrower one.

**The script-named display subset.** Most guides are ordinary pronunciation help. The subset where the
author is doing something *with* the word — a **Han-script word given a katakana reading** — is:

| | |
|---|---|
| rows, series-wide | **192** |
| distinct readings | **99** |
| occurrences | 668 |

That rule **names two writing systems**. It is a rule about this series' orthography, not a rule about
guided forms, and this repository's owner rule is that nothing is hard-wired to one language. It is
kept as a **display** filter — it is the right set to show a model (§4.5), and it is how §2.3's table
was found in the first place — and it is **not** the load-bearing identity rule. In code it is
`isGuideGroupKatakanaOverHanForm`, and `collectGuideGroups` never consults it.

**The script-neutral candidate set.** Four guards, all of them mechanical facts about two strings, none
of them asking which script either side is written in: the reading is 2+ characters long; the reading
shares no character with the written form; 2+ distinct written forms carry that reading; and at least
one of those forms is 2+ characters long. Measured over the 17 volumes, 0 model calls:

| | |
|---|---|
| harvest rows read | 10,005 |
| rows dropped — the reading is 1 character long | 1,084 |
| rows dropped — the reading shares a character with the form | **10** |
| rows skipped — the row names no written form (one real one: volume 11 guides a ruby with no base text at all, マイナス) | 1 |
| rows left, over distinct readings | 8,910 rows / 3,316 readings |
| readings dropped — only one written form carries it | 3,099 |
| readings dropped — every form under the reading is one character long | 120 |
| **candidate groups** | **97** |
| distinct written forms across them | **222** |
| harvest rows inside them | **634** |
| occurrences inside them | **8,734** |
| volumes they touch | 17 of 17 |
| of those groups, the display filter selects | 14 |

**The shared-character guard is nearly inert on this corpus, and that is a measurement, not an
oversight.** It fires on **10 of 10,005 rows**. The harvest stores the word *already guide-free* (gotcha
123), so a reading almost never has a character of the word to reuse: 蒲 guided かま passes the guard
cleanly. The guard is script-neutral and it stays — it is the honest statement of "the author wrote
something other than the word's own pronunciation" — but the guards that actually do the separating are
the reading's length and the requirement that one form be multi-character.

**The candidate set contains the noise, on purpose.** 美味 / 上手 → うま, 呆然 / 茫然 → ぼうぜん,
披露 / 疲労 → ひろう, 振動 / 震動 → しんどう, 可哀想 / 可哀相 → かわいそう are all in it, beside
翌桧 / 羽立桧菜 → あすなろ and 撫子 / 赤井撫子 → なでしこ. The reader generates candidates; deciding is
§2.9 and slice 2. A reader that filtered the noise here would be deciding the plan's central question
with a rule nobody reviewed.

### 2.3 The finding that changes the design — and the three numbers in it that were wrong

Asked which of the 99 display readings the author prints over **more than one written form**, the
original answer was 24. **That counted readings printed over 2+ distinct (volume, form) pairs.** Asked
about written forms alone, **14** of the 99 qualify. Ten of the 24 are one written form printed in
several volumes, which is a different claim and not the design-changing one:

> イラストレーター ← 世界の支配者 (7 volumes) · ブリキ ← 神 (7) · くさみルナ ← 草見月 (7) ·
> ガーベラ ← 大千本槍 (4) · サザンカ ← 山茶花 (3) · ウータン ← 庄本先生 (3) · ボンヤリこ ← 本槍子 (3) ·
> カビラ ← 川平 (2) · ローリエ ← 月桂樹 (2) · ワサビ ← 山葵 (2)

The 14 that really are printed over more than one written form:

| Reading | Written forms the author used for it |
|---|---|
| **パンジー** | 虹彩寺菫 x406, 三色院菫子 x18, 三色菫 x12, 菫 x2, 好きな女 x2, その綺麗な女性 x1, お姫様 x1, 友達 x1, 主人公 x1, 恋人 x1, 朱雀 x1, 虎 x1 — **10 volumes** (01, 04, 05, 06, 09, 10, 14, 15, 16, 17), not 12; 虹彩寺菫 is 311 occurrences in volume 15 and 95 in volume 16 |
| **コスモス** | 秋桜 x5, 生徒会長 x2, 秋野桜 x2, 青龍 x1, 怪物 x1 |
| **チエリー** | 桜原桃 x5, 桜桃 x2, 面倒事 x1, 元生徒会長 x1 |
| **サンちやん** | 親友 x3, 大賀太陽 x2, 王子様 x1, 大賀先輩 x1 |
| **ビオラ** | 菫 x8, 虹彩寺菫 x3, 好きな人 x2, 誠実 x1 |
| **ホース** | 葉月保雄 x4, 好きな男 x1, 主人公 x1 |
| **ジヨーロ** | 親友 x2, 玄武 x1, 如雨露 x1, 主人公 x1 |
| **ヒイラギ** | 柊 x2, 元木智冬 x2, 人見知り x1 |
| **プリムラ** | 乙女桜 x1, 早乙女桜 x1, 新生徒会長 x1 |
| **モブ** | 脇役 x4, 主人公 x1 |
| **ツバキ** | 椿 x2, 特別な存在 x1 |
| **ミント** | 薄荷 x2, 自分の彼氏 x1 |
| **アイリス** | 恋人 x1, 文目 x1 |
| **スパイラル** | ねじ込む x3, ねじ切れそう x1 |

Under the script-neutral rule the same question gives **97 groups / 222 written forms / 634 rows /
8,734 occurrences, homophone noise included** (§2.2). The 14 above are a subset of the 97.

**The author writes a description and guides it with a name.** 好きな女 — "the girl I like" — read
パンジー. 主人公 — "the protagonist" — read サンちやん. 世界の支配者 — "the ruler of the world" — read
イラストレーター. Identity is hidden behind a description and the reading is the tell.

Three consequences, each load-bearing:

- **No name-matching rule can ever find these links.** "The protagonist" and 大賀太陽 being the same
  person is not discoverable from strings. It is discoverable from the guide.
- **虹彩寺菫 → パンジー 311 times and 三色院菫子 → パンジー 16 times, in volume 15.** A name changes
  *within* one book. That is a relation with a date, which is exactly what `valid_from` / `valid_to` is for.
- **サンちやん vs サンちゃん** — the two roster entries one character apart, open since plan 06 — is
  settled by the guide, which prints the first form over four written forms. (Measured again in §2.9:
  the guide's spelling is one edit from the roster's, and so are チエリー / チェリー and ジヨーロ / ジョーロ.)

### 2.4 A correction to plan 06, stated because a later slice must not reuse the old number

Plan 06 **§2.11** (this plan's first draft cited it as §2.3, which is the aspect-collapse section)
measured the guide file as stating **13 name links across 24 roster entries** and concluded
it was a weak source. **That measurement asked the wrong question.** It looked for pairs where *both* sides
were already roster names. The valuable shape is *any written form guided to the same reading*, which
includes descriptions that are not names at all. Measured correctly: 192 rows / 99 readings in the display
subset, and **97 candidate groups / 222 written forms / 634 rows / 8,734 occurrences** under the
script-neutral rule. Plan 06's conclusion — "no source states most of these links in a form a door can
file" — is **retired**, and the row in plan 06 §2.11 that carries the 13-pair number now says so.

### 2.5 What the published records hold today (unchanged, and still the reason everything is fixture-proven)

Measured over copies of all 17 records: **22,469 facts, every one `aspect = 'term_usage'`** — the records
are a dictionary with no people in them. **0 facts keyed to a cast entry.** 0 records have an `axis`
column. Published glossary tables: volume 01 129 rows, volume 02 244, volume 17 1,036.

### 2.6 The cost of the label change, measured

Renaming the glossary heading breaks **0 rows for all three readers on 279 of 279 test glossaries** — every
reader drops the header row by position, and exactly one door writes it. Importing the same glossary under
either heading produces identical records. The cumulative "nothing was lost" gate answers the same either
way. Zero false positives. The code cost is one line plus one assertion. The real cost is re-rendering 17
published glossaries, which the freeze gate refuses once a translation has been built on the file — and
**no translation exists today**.

### 2.7 Two filters that were tried and failed, written down so nobody re-tries them

Both were attempts to separate the identity-bearing groups from the phonetic-complement noise *inside
the reader*. Both failed, and the reader therefore does neither.

1. **Use the harvest's own annotation sequence to tell a whole-word guide from a partial one.** The
   harvest records each annotation's base-and-reading sequence (`annotated`, schema 2 — the shape
   gotcha 123's tripwire needed). The hope was that a guide sitting on one character of a multi-character
   word would be visible there. **It is not in the data: all 10,005 rows report full coverage, 0 partial.**
   The rows are keyed by the whole written form, so partial coverage cannot be recovered from them. The
   field answers "which character carried which reading", which is a different question, and it is not
   a candidate filter.
2. **"A homophone group is all single-character forms; a label group contains a multi-character form."**
   **It drops 0 groups.** Homophone groups contain multi-character forms too: うま ← 美味 x113 / 上手 x104,
   ひろう ← 披露 x26 / 疲労 x5, ぼうぜん ← 呆然 x19 / 茫然 x4.

What does work is the blunt version of that second idea — **at least one form in the group is 2+
characters long** — and it is a length rule, not a script rule. It drops **120 of the 217** groups the
first three guards produce. **Its measured cost:** one of those 120 is しば ← 芝 x416 / 縛 x10, and 芝 is
a name the published record already holds. One known false negative, pinned in
`test/test-guide-groups.js` scenario 4 so widening the guard later is a decision rather than a discovery.

### 2.8 The plant-naming pattern — a hypothesis, not a measurement

The gold groups cluster on plants, and the author alternates between the plain plant word and the
character's actual name, guiding one with the other's reading:

| Reading | The plant word the author guides | The person's own name, guided with the same reading |
|---|---|---|
| あすなろ | 翌桧 x4 | 羽立桧菜 x1 |
| ヒイラギ | 柊 x2 | 元木智冬 x2 |
| なでしこ | 撫子 x105 | 赤井撫子 x1 |
| たんぽぽ | 蒲公英 x6 | 蒲田公英 x3 |
| ひまわり | 向日葵 x6 | 日向葵 x2 |
| コスモス | 秋桜 x5 | 秋野桜 x2 |
| チエリー | 桜桃 x2 | 桜原桃 x5 |
| パンジー | 三色菫 x12, 菫 x2 | 三色院菫子 x18, 虹彩寺菫 x406 |
| ビオラ | 菫 x8 | 虹彩寺菫 x3 |
| プリムラ | 乙女桜 x1 | 早乙女桜 x1 |
| アイリス | 文目 x1 | (no personal name guided; the roster's own entry is **アイリス**) |
| ミント | 薄荷 x2 — **the roster's entry is the plant word itself** | (no personal name guided) |
| ツバキ | 椿 x2 | (no personal name guided; the roster's own entry is the reading, **ツバキ**) |

**Hypothesis:** for this series the guide file *is* the identity key, and the homophone noise is the
price of reading it. It is written here as a hypothesis because the *plant* pattern itself has not been
measured — §2.9's roster test selected 18 groups without ever asking what a word means, and "the cast
is named after plants" is an observation about 13 of them, not a rule anyone has run. What §2.9 *did*
measure is that the record can pick the identity-bearing groups out of the 97; whether a plant-naming
rule would do it better, or reach the ones the roster test misses, is slice 2's question.

### 2.9 The decisive measurement: can the record tell the identity groups from the noise?

The question slices 1–2 depend on. Run by `test/measure-guide-groups.js` over the 17 volumes and a
**copy** of volume 17's record (gotcha 124), 0 model calls.

**The roster.** The published `## Characters` tables across the 17 glossaries hold **196** distinct
terms; a copy of volume 17's `cast` table holds **196** keys; **the two sets are identical** — which
confirms plan 06 §2.11's finding that the roster *is* the glossary's Characters table.

**The cast-name rule, tested as written** — *a group is an identity link when at least one of its forms
is a name the record already knows and at least one other form is not*:

| Class | Groups | Harvest rows | Occurrences |
|---|---|---|---|
| at least one form known, at least one form unknown | **15** | 111 | 1,107 |
| every form known | **2** | 20 | 292 |
| no form known | **80** | 503 | 7,335 |

**It separates the noise cleanly and it is not the right rule.** All 15 are real links — すみれこ
(菫子 / 董子), パンジー, なでしこ, ビオラ, たんぽぽ, ひまわり, コスモス, チエリー, サンちやん, あすなろ,
ホース, ヒイラギ, プリムラ, ミント, アイリス — and **none of the homophone noise is in them**: うま,
ぼうぜん, しんどう, かわいそう, ひろう, かわ, かし, いか, たち, かわい, わがまま and the other 69 are all
in the no-known-form class. **Zero false positives on this corpus.**

But the "and at least one other form is not" half throws away two groups that are exactly what slice 2
is for: **さんしよくいんすみれこ ← 三色院菫子 x289 / 三色院董子 x1** and **つきみ ← 月見 / 草見月** —
links where *both* sides are already roster names, which is the shape plan 06 §2.11 was built to look
for and found almost none of. Dropping them is the mistake that measurement made, reappearing in a new
rule.

**The better separator the measurement found:** *a group is identity-bearing when at least one of its
forms is a roster entry, **or the reading itself is one***. That selects **18 of the 97** — 134 harvest
rows, 1,402 occurrences — and leaves 79 out (500 rows, 7,332 occurrences). The reading test adds 11
groups on its own — パンジー, ビオラ, たんぽぽ, ひまわり, コスモス, あすなろ, ホース, ヒイラギ, **ツバキ**,
プリムラ, アイリス — because the glossary recorded the guided reading as the character's entry, so the
roster already carries the author's nickname. ツバキ ← 椿 / 特別な存在 is the case the form test alone
misses.

**What even the better rule misses**, and it is worth naming before slice 2 is built:

- **ジヨーロ** ← 玄武 / 親友 / 如雨露 / 主人公. Its reading is one edit from the roster's ジョーロ, and
  its form 如雨露 is a truncation of the roster's 如月雨露. Neither is an exact match, so nothing selects it.
- **モブ** ← 脇役 / 主人公, and the pronoun groups **おれ** (← 俺 x3,820 / 脇役), **あなた** (← 貴方 x535 /
  貴女 x278), **あなたたち**, **あなたさま**, **わたし** (← 自分 / 他人 / 菫). Every form is a description or
  a pronoun, so a roster test cannot see them. Whether they are identity links at all is an open question
  (§6.6), not a measurement.
- Three readings sit **one edit** from a roster entry without being one: チエリー / チェリー,
  サンちやん / サンちゃん, ジヨーロ / ジョーロ. An exact-match roster test is not enough for a book that
  spells its own nicknames two ways; the store's own name rule is the door that has to answer this, and
  widening it is a decision (gotcha 121 kept the matching rule narrow on purpose).
- The display filter selects three groups the roster rule does not: ジヨーロ, モブ, スパイラル.

**The answer to the question.** Yes — the record can separate the identity-bearing groups from the
homophone noise, with zero false positives on the real corpus, using only rows the record already holds
and 0 model calls. Slices 1 and 2 are buildable. What they must not do is require one form to be unknown.

### 2.10 The 79 unselected groups split cleanly — and the split is the owner's answer

The account owner's answer to "what happens to the 79 groups no rule selects?" was not one of the options
offered: *"I suspect this is something related to a typo the author or the publisher's editorial staff made…
the 'same word different spelling' problem probably should be noted down like how 'color' and 'colour' are
the same word… the glossary should definitely account for that."* That is a testable claim, so it was tested.

Measured by **how much of the shorter written form survives inside the longer one** (longest common
subsequence, over the closest pair in the group), the 79 split **25 / 54**:

**One word spelled two ways — 25 groups.** 偽物 x11 / 偽者 x10 · 我侭 x77 / 我儘 x1 · 太股 x12 / 太腿 x1 ·
潑溂 x8 / 潑剌 x2 · 叱咤激励 / 𠮟咤激励 · 呆然自失 / 茫然自失 · 可哀想 x8 / 可哀相 x2 · 煽情的 / 扇情的 ·
貴婦人 x1 / 鬼婦人 x8 · 貴方達 x10 / 貴女達 x9 · 貴方様 x2 / 貴女様 x2 · 貴方 x535 / 貴女 x278 ·
振動 x13 / 震動 x3 · 呆然 x19 / 茫然 x4 · 下賎 x3 / 下賤 x3 · 怒濤 x1 / 怒涛 x10 · 凍気 / 闘気 ·
性実 / 誠実 · 小鹿 / 子鹿 · 巨乳美女 / 虚乳微女 · 魅上 / 三上 · 可愛 x499 / 可哀 x1 · 小原 x2 / 小腹 x1 ·
凛々 / 凜々 · ねじ込む x3 / ねじ切れそう x1. **This is the color/colour class, and it is real.**

**Different words that sound alike — 54 groups.** 美味 x113 / 上手 x104 / 旨 x2 · 披露 x26 / 疲労 x5 ·
串 x132 / 駆使 x3 · 傾 x46 / 菓子 x33 · 挑 x42 / 井戸 x1 · 皆 x103 / 見慣 x1 · 卑怯 x20 / 秘境 x1 ·
行為 x17 / 厚意 x3 · 選択 x6 / 洗濯 x1 · 紳士 x4 / 真摯 x1 · 蜘蛛 x2 / 曇 x4 · 大阪 x7 / 逢坂 x1 …
**Nothing here is a typo.** They are ordinary homophones the author chose to gloss.

The split is not perfect — 小原 (a surname) / 小腹 (lower belly) and 魅上 / 三上 land in the variant class
and are arguable — but it separates 25 real spelling variants from 54 things that are not, with one
deterministic, language-neutral computation: **how much of one written form is still there in the other.**

### 2.11 Two things this plan said that are wrong, corrected before a slice builds on them

**(a) サンちやん, チエリー and ジヨーロ are not spellings the book prints.** They are the author's **ruby
readings**, and they appear **0 times** in the extracted text of all 17 volumes. The roster's spellings are
body text: サンちゃん appears **81 times in volume 13** and チェリー **40 times in volume 16**. So the
"three nicknames spelled one character apart" framing was wrong — the two spellings are not two printings of
one name in the prose, they are **the same nickname written as body text in one place and as a reading over
someone's head in another**, and the ruby version writes full-size kana where the body text writes small
kana (ちや/ちゃ, ヨ/ョ, エ/ェ). That is a typographic convention, not a typo.

**The store already has the rule, and already refuses to use it.** `foldSmallKana`
(`utils/reference-store/identity/sources.js`) folds small kana onto the full-size form, and the guide half
already files a **near miss** rather than a link when a reading is a roster name spelled differently —
since slice 2 that is `guideNearMisses`, asked over **every** candidate group, selected or not, because
§2.9 names ジヨーロ although it does not select it. Measured against the three pairs:

| pair | folded | resolved by the existing rule? |
|---|---|---|
| サンちやん / サンちゃん | both → サンちやん | **yes** |
| ジヨーロ / ジョーロ | both → ジョーロ | **yes** |
| チエリー / チェリー | unchanged | **no — the fold table has ェ→エ missing** |

So the answer to the owner's question is not "widen the matching rule", which gotcha 121 refuses: it is
**one entry added to a fold table that exists for exactly this purpose**, and the fold stays a reporting
rule. Two of the three are already visible today; the third is one character of a table.

**Built (slice 2, 2026-10-15):** the entry was added — `SMALL_KANA_TO_FULL` now carries **ェ U+30A7 → エ
U+30A8** — and the measurement confirms what it buys: **3 near misses named with the entry, 2 without**,
0 ambiguous. The katakana small vowels ァ ィ ゥ ォ and the hiragana small vowels are still absent and are
named in the comment rather than added beside a fix nobody measured.

**(b) 董子 — this plan called it a bad file, and the measurement says it is a name. The claim is withdrawn.**
What §2.11 originally said was that 董子 (92 occurrences, 75 of them in volume 17 chapter 6) against 菫子 (646
across 11 volumes) is "the shape of a bad file, not a name", with 菫 U+83AB / 董 U+8451 close enough to look like a
conversion artifact. Re-measured against the harvest and the record's own glossary, that diagnosis does not hold:

- **The author guides it.** Volume 17's harvest records 董子 guided **すみれこ 76 times, in chapters ch5 and ch6**.
  A pronunciation guide is an authorial act: nobody puts one over a character that slipped in. The same file guides
  三色院菫子 as さんしよくいんすみれこ 7 times (ch3, ch6).
- **The chapter is a flashback.** Volume 17 chapter 6 is 第六章 **俺とお前の始まり** — "the beginning of you and me".
- **The record already says so.** Volume 17's published `## Characters` table holds **董子** and **三色院董子** as
  entries, with its own notes: *"Name used to address 三色院菫子 in the flashback section … A message reads
  '久しぶり、董子'"* and *"Full-name form of パンジー printed in this volume: '三色院董子。だから、俺達は『パンジー』って
  呼んでる'"*. So the roster rule of §2.9 selects the すみれこ group **because the roster already carries both
  spellings** — and on this evidence that is the correct answer, not a false positive.
- **It is not confined to one volume.** 董子 is guided 3 times in volume 15 and 10 times in volume 16 as well.
  In volume 17's own text 董子 is printed 79 times against 菫子's **7**.

**What the real anomaly is, and it is a different shape.** The same harvest guides **one written form two different
ways in the same chapter**: 三色院董子 appears with さんしよくいん**すみれ**こ and with さんしよくいん**すれみ**こ, both in
ch5. A reading whose moras are transposed is the defect; a spelling the author guides 76 times is not.

**The consequence, and it lands on slice 2b.** A detector built on *concentration alone* reports a legitimate name
as a source error. The guide is the discriminator: **a form the author guides with a reading is a form the author
chose**, and the anomaly class worth reporting is *inconsistent guidance* — one form guided two ways, or one reading
printed two ways — not *uneven frequency*. Slice 2's rule that "董子 is reported as an anomaly and never as a link"
is **withdrawn**: §2.9's rule already files the link correctly, and the plan should not ask slice 2 to undo a true
fact because of a diagnosis this section got wrong.

By contrast 如雨露 (11 times, spread 1–2 per volume across 8 volumes) against 如月雨露 (281 times across 16
volumes) is thinly spread, which is the shape of a name written short, not of a corrupted chapter — and it stays
out of the anomaly class for the same reason it always did.

**And the obvious typo detector is not one.** "One form at least 10× more common than another under the same
reading" produces **132 candidate pairs** on this corpus, most of them single-mora guides — 込 x36 / 子 x2 /
木 x1 all read こ, 尽 x35 / 着 x3 / 吐 x1 all read つ. Frequency asymmetry alone finds nothing; the pair has
to be multi-character on both sides and concentrated somewhere specific.

### 2.12 "Guides on rare kanji" has no computable meaning, and the closest one is not rare

The owner's answer on the annotated view was *"the renames plus guides on rare kanji"*. **Nothing in the
extraction says a kanji is rare**, and the nearest computable proxy turned out to select the commonest words
in the language: the forms guided **every single time they appear in their own volume** number **6,341 of
9,663**, and the top of that list is 貴方 → あなた (92×), 可愛 → かわい (52×), 友達 → ともだち (51×),
恋人 → こいびと (37×), 一緒 → いつしよ (78×). The author glosses ordinary words out of habit.

What the proxy *does* find, at the rare end, is something more interesting than pronunciation: **the author
annotating a whole phrase with its meaning.** Always-guided and appearing at most twice, 4,606 forms, the
longest of them:

> 達の戦いはこれからだ → 強制終了 ("the battle is only beginning" glossed as "forced ending") ·
> あちら側の皆様 → 読者 ("those on the other side" glossed as "the reader") ·
> ＥＮＴＲＡＮＣＥ → 入り口 · アリーヴェデルチ → さよなら (Italian *ciao*, glossed as "goodbye") ·
> ひふんへはべふ → じぶんで食べる · 犠牲になってくれる → 手をあげる ·
> 不肖如月雨露 → ふしようきさらぎあまつゆ · 二拝二拍手一拝 → にはいにはくしゅいつぱい

Those are not pronunciation help. They are the author writing a meaning over a string, and a translator who
never sees them loses the joke.

**What each view costs**, measured as added markup characters over the 2,450,316 characters of source text:

| view | forms | guided occurrences | added characters |
|---|---|---|---|
| the renames only | 202 | 1,033 | **+31,630 (1.3%)** |
| renames + always-guided and appearing ≤ 2 | 4,808 | 6,739 | **+192,251 (7.8%)** |
| every always-guided form | 6,341 | 19,250 | +537,834 (22%) |
| every guide the converter set aside | 9,663 | 45,429 | ≈ +1,181,154 (48%) |

**This plan takes the second row** as the computable meaning of the owner's answer: the renames, plus a guide
shown only where the author applies it **every single time** the word appears **and** the series uses that
word no more than twice. It is language-neutral, it costs 7.8% more text, and it is the only row that
catches the phrase glosses above. If the owner wants the third row instead, that is a bigger prompt and the
same door.

**Corrected 2026-10-15 by slice 5, which built this row and had to reproduce it.** `test/measure-annotated-view.js`
now recomputes all four rows above from the 17 harvests and prices each with the markup shape the shipped
renderer emits, so the table can be re-measured rather than remembered. Its output, over 10,005 harvest rows
(9,663 (volume, form) pairs — one row guides a ruby with no word under it at all, and the store's filing door
refuses it):

| view | this plan's row | recomputed, same markup shape | reproduces? |
|---|---|---|---|
| the renames only | 202 / 1,033 / +31,630 | **202 / 1,033 / +28,033 (1.14%)** | forms and occurrences yes, characters no |
| renames + always-guided and ≤ 2 | 4,808 / 6,739 / +192,251 | **4,808 / 6,739 / +176,271 (7.19%)** | forms and occurrences yes, characters no |
| every always-guided form | 6,341 / 19,250 / +537,834 | **6,341 / 19,250 / +497,425 (20.30%)** | forms and occurrences yes, characters no |
| every guide the converter set aside | 9,663 / 45,429 / ≈ +1,181,154 | **9,663 / 45,428 / +1,145,628 (46.75%)** | forms yes, occurrences off by the one form-less row, characters no |

**Three corrections, then.** **(1)** No markup shape this repository could emit reproduces the character column:
one annotation costs `<ruby></ruby>` + `<rt></rt>` = 22 characters plus the reading, which over 6,739 occurrences
is **176,271**, not 192,251, and no model of per-occurrence / per-piece / per-reading-character cost fits all
four rows. Every row is **cheaper** than this section claims. **(2)** "the series uses that word no more than
twice" is not a series-wide count: counted **per volume** the always-guided-within-the-bound set is **4,712**
pairs / 5,830 occurrences, or **4,606 / 5,706** once the 202 renames are taken out — which is where 4,808 comes
from, as the union — while counted **across the whole series** it is **1,898** pairs (1,831 without the renames).
The prose and the number describe different counts. **(3)** The row is missing the guard that makes "every
single time" checkable: the extracted text records no guide **positions**, so the only way to know a form is
guided every time it appears is to compare the guided count against the printed count in that volume's own text.
Over the whole harvest **3,322 of the 9,663 pairs are guided fewer times than their book prints them** — 26,178
guided against 100,354 printed, so annotating every printed place would invent **74,176 guides** the author never
wrote; over the rows the store's own guards file, the same rule refuses **2,532 forms (21,082 guided against
64,326 printed, 43,244 invented guides)**. With that guard the row is **4,497 pairs / 5,546 occurrences /
+145,054 characters (5.92%)**. The phrase glosses the section is worried about are still in the set.

### 2.13 "Each volume files only its own harvest" and "the union is 97 groups" cannot both be true

Slice 1 was built and measured, and the acceptance line written for it — including the wording I amended
myself in commit `2c67ce2` — asks for two things that are mutually exclusive. Measured by
`test/measure-written-forms.js` on copies of all 17 records, 0 model calls:

| What the pass does | Groups | Rows | Occurrences |
|---|---|---|---|
| Each volume's harvest folded **alone**, a reading counted once per book | 115 | 240 | 3,196 |
| What the door filed **when it filed only candidate groups** — the scope this section was written about | **57** | **240** | **3,196** |
| All 17 harvests folded **together** — §2.2's number | **97** | **634** | **8,734** |
| **What the door files now** (the owner's answer, §6.7): every row passing the two *row* guards, grouping answered by query | **97** | **634** | **8,734** |

**The gap is closed, and it was closed by moving the judgement out of the door, not by letting a volume read
ahead.** The widened door files **8,910 rows / 41,710 occurrences** across the 17 books — 8,670 of them rows the
group guards would have refused — and reading those rows back through `candidateGroupsInRecord` reproduces §2.2's
97 / 222 / 634 / 8,734 exactly, with **0 groups and 0 rows of gap**, and no volume ever opened a later book. The
18 identity-bearing groups now arrive **in full** in the cumulative record, where under the narrow scope 3 arrived
not at all and 14 arrived partial.

**"One reading printed over two or more written forms" is a question about a set, and a set is not
decomposable per volume.** The gap is 40 groups and 394 rows, and it is not scattered noise: of the 18
identity-bearing groups, **three are never a candidate group in any single book** — ホース ← 葉月保雄
(vols 7, 16) / 主人公 (5) / 好きな男 (4); ミント ← 薄荷 (7) / 自分の彼氏 (9); つきみ ← 月見 (4) / 草見月 (11)
— because their second written form appears in a **later** volume. **Fourteen more are reached with a
partial span** (すみれこ 13 volumes → 1, さんしよくいんすみれこ 17 → 1, パンジー 10 → 6, たんぽぽ 7 → 2,
ひまわり 7 → 4, コスモス 7 → 3, チエリー 5 → 3, サンちやん 5 → 2, あすなろ 4 → 2, なでしこ 3 → 1, ビオラ
3 → 2, ヒイラギ 2 → 1, ツバキ 2 → 1, プリムラ 2 → 1) and **one in full** (アイリス, whose whole span is one
book). A cumulative fold — volume N folding harvests 1..N — is monotone 11 → 97 and reaches exactly
97 / 634 / 18 / 134 / 1,402 at volume 17, but only by reading earlier books' harvest files.

This is the same wall §2.9 hit from the other side, and it is worth stating as a principle: **an identity is
a series-level thing, and a volume-level door can only ever see the part of it that one book printed.** It
does not invalidate the design — the record is cumulative, so the rows a volume files travel forward — but
it decides *who does the grouping*, and that is now an open decision (§6.7).

---

## 2b. The account owner's answers, 2026-10-15

Asked, answered, and binding on the slices below.

| Question | The owner's answer |
|---|---|
| What should the two glossary columns be called? | **`Original` / `Translated`** |
| How much pronunciation help should a model see? | **The renames plus guides on rare kanji** — made computable as §2.12's second row |
| Are groups made only of descriptions and first-person pronouns (おれ, あなた, わたし, モブ) characters? | **Record the words, no character.** The record says the book prints 脇役 guided as 俺; it does not claim a person. |
| What about names spelled one character apart? | **Treat them as typos by the author or the publisher's editorial staff, and account for typos and grammatical errors in the source material generally** — which §2.11 shows is the wrong diagnosis for these three and the right instinct for a class the pipeline has **no** handling for today |
| What about the 79 groups no rule selects? | **Judge them case by case; note the same-word-different-spelling ones the way English notes *color* / *colour*; the glossary should account for that** — which §2.10 measures as 25 groups |
| What should a volume's record actually store about the author's pronunciation notes? (asked after §2.13 showed the two clauses of slice 1's acceptance line are mutually exclusive) | **Store every note the author wrote, and decide what is interesting later.** Each volume files every harvested row that passes the two *row* guards, and the *group* question is answered by query, never at filing time — plan 07 §6.7 is now answered, and it is option **C** |
| Should a written-forms row be sealed with its volume, the way a glossary or voice row is? | **No seal.** The owner's reason: *"future volumes won't be touching this volume's copy"* — a later volume works in its own copy, so a seal on a row that reaches no published file protects nothing. This matches what `identity/file.js` already reasons, and it is now the stated rule rather than a borrowed one |

**The new requirement this opens, and the measurement that shows it is real:** nothing in this pipeline
accounts for a typo, a variant spelling or a grammatical error **in the source book**. The only places the
word "typo" appears are the wiki validator's severity ladder (`jump-in-wiki-validator.md:91`, a 🟢 nitpick)
and one example in the consistency audit's severity rules (`consistency-audit.md:81`), and both are about
the artifacts, not the book. `findRenderingVariants` is about the **translation's** spellings. So a volume
whose file prints a character's name wrong 75 times in one chapter, and a series that spells 偽物 both ways,
currently reach the translator with nothing said about either. That is slice 2b.

---

## 3. What this replaces, and what it leaves alone

**Replaced or retired**
- Plan 06 §2.11's roster-link measurement and its conclusion (§2.4).
- The `Japanese | English | Notes` heading.
- The idea, floated in plan 06 §10.9, that the identity table might never be wired: this plan wires it,
  because the relations model cannot exist without it.

**Left alone, deliberately**
- The stored, guide-free text. Matching, quoting and the evidence rule all compare against it, and
  re-inserting guides re-breaks all three (gotcha 123 measured 16 HIGH and 31 MEDIUM findings from a
  *removal*; a re-insertion is the same hazard in the other direction).
- The glossary's newest-wins settled record. Terminology is expected not to change; the owner's rule says
  future information *should* reach earlier terms there, and must not reach voice.
- Plan 06's declaration machinery. It stays, and it gets cheaper to use: a relations row answers a
  question without needing the question declared in advance.
- The copy-forward snapshot model, the reopen door, the freeze gate, the acceptance windows.

---

## 4. The design

### 4.1 A written form is a first-class thing

A **written form** is one way the series prints a name or a description: `虹彩寺菫`, `三色院菫子`,
`好きな女`, `主人公`. It is not a person. It carries: the base text, the reading the author guided it
with (if any), the script of that reading, the volumes and chapters it appears in, and how often.

The roster stays what it is — a list of forms — and stops pretending to be a list of people.

### 4.2 An identity is a set of forms, with no name attached

Plan 06's `cast_identities` / `cast_identity_links` already have this shape, including the owner-approved
rule that **an identity carries no label**, because the sources state the link and never state which form
*is* the person. This plan makes it load-bearing rather than dormant, and widens its source rule from
"name-to-name pairs" to "any two forms guided to the same reading".

### 4.3 The relations table

One row per observed act of address, keyed on identities rather than on name strings:

| Column | Meaning |
|---|---|
| `addresser` | the identity doing the addressing, or `narrator`, or null when withheld |
| `addressee` | the identity being addressed; the same as `addresser` for self-address; null when none |
| `channel` | `spoken` · `self-address` · `inner-monologue` · `narration` · `withheld` |
| `form_used` | the written form, with its guided reading when the author gave one |
| `statement` | what the record asserts, in the **source language** |
| `certainty` | a level derived from measured evidence (§4.4), never a model-reported number |
| `valid_from_volume` / `valid_from_chapter` | where the record first saw it |
| `valid_to_volume` / `valid_to_chapter` | null while it holds |
| `closed_by_volume` / `closed_by_chapter` / `closed_by_quote` | **why** the span closed — decision 8 |
| `established_volume` | which volume's own text first showed it |

Two rules that are not negotiable:

- **A row is never edited after the volume that filed it published.** A span closes in the *copy* the
  later volume is working in; the earlier volume's snapshot never changes. That is the owner's
  no-forward-leak rule, and it is what makes `valid_to` safe here when it would be unsafe in a single
  shared table.
- **A volume's translation reads that volume's record.** Nothing written in volume 9 can reach volume 1's
  reference. Already true for voice; this plan pins it in a test so a later refactor cannot quietly
  reverse it.

**What slice 3 actually built, so slice 4 reads this table and not a guess** (2026-10-15): the table is
`relations`, 25 columns, `relation_id` a surrogate key, and `idx_relations_key` unique over
`(established_volume, channel, form_used, ifnull(addresser,-1), ifnull(addressee,-1))`. Three changes to the
column list above, each one made deliberately: **`closed_by_line` was added** (every other citation in this
store records the line it was found on, and a close that names a chapter but not a line is the close a later
reader cannot re-check); **`closed_at` was added** (a close is an act with a date, and `facts` already stamps
one); and **there is no free-text reason column** — the quote is the reason. The acceptance line's "closed
without a reason is refused" is enforced as *no volume, no chapter, or no quote*, plus a quote the closing
volume's own text does not print, because a second reason field invites a justification nobody can check and
`cast_identity_links.withdrawal_reason` is the precedent where a sentence-with-a-minimum-length did not stop
the next slice from asking what the sentence meant. `addresser` / `addressee` are nullable foreign keys to
`cast_identities(identity)` beside closed `addresser_kind` (`identity` · `narrator` · `withheld` · `unknown`)
and `addressee_kind` (`identity` · `none`) vocabularies, which is how the narration gets a row without a
person (gotcha 121). `valid_from_volume` is kept **equal** to `established_volume`, and the equality is
pinned.

### 4.4 Certainty is a ladder built from what the record can measure

A model's self-reported percentage is a feeling with two decimal places. What the record *can* measure:

| Level | The measured condition |
|---|---|
| `measured` | the line names exactly one cast form, it is not the person being spoken to, and the guided reading resolves it to one identity |
| `addressee-risk` | the line names a cast form but that form is the person being spoken to — the measured failure mode: 10 of 10 in volume 2 |
| `reading-resolved` | the identity is known only because the author's guided reading says so |
| `narration` | the line is narration; the "speaker" is the narrator, which has no roster entry |
| `withheld` | the book pointedly does not say. **A fact, not a gap.** |
| `unknown` | nothing matched, and the book did not withhold |

`withheld` is first-class because it carries translator-relevant instruction: keep it unresolved.

**How the ladder was actually built (slice 4, 2026-10-15), and where it is stricter than the table above.**
`measured` requires the cited line to name **exactly one** cast form, that form to resolve to the **addresser's**
identity, and the addressee to be a **different** identity. The table's middle clause — "it is not the person
being spoken to" — would let a line whose one cast form belongs to a **third** person be called `measured`; the
build refuses it, because a line naming somebody who is neither party says nothing about who is speaking it.
The consequence is real: a **self-address** and an addressee-less **inner monologue** can never be `measured`,
since that is the level that separates two people. `addressee-risk` is asked **before** the guide rung (a line
whose one cast form belongs to the addressee is a wrong answer the markup cannot overrule), and it also fires
from the other side — when the form used is itself a form of the addressee. `reading-resolved` rests only on a
link the record already holds and so needs no verified line. The gap levels are never asked of the ladder: they
come from the entry's own shape. Nothing firing files **nothing** — there is no fallback level — and every rung
that failed is named, in order.

### 4.5 The annotated view, not the annotated archive

The model-facing view of a chapter re-emits HTML `<ruby>` for **§2.12's second row** — the renames, plus a
guide the author applies **every single time** the word appears and the series uses **no more than twice**:
4,808 forms, 6,739 occurrences, **+192,251 characters measured against 2,450,316 characters of source text
(7.8%)**. Not 45,429 occurrences, which would cost 48%. The stored bundle is unchanged. Markdown has no ruby
syntax; pandoc's extension is not standard; `<ruby>` is what the converter already parses on the way in, so
the model needs no teaching.

The rule is chosen because it is the only one in §2.12 that is both computable and worth paying for. "Rare"
is not computable from this data — the forms guided every single time include 貴方 → あなた (92×),
可愛 → かわい (52×) and 友達 → ともだち (51×), which are the commonest words in the language. What the
rare end actually contains is the author writing a **meaning** over a whole string, and that is the part a
translator loses.

**How the view was actually built (slice 5, 2026-10-15), and where it differs from the paragraph above.** It
reads the record's own written-form rows, never a volume's harvest file — `written-forms/file.js` stays the one
door in this store allowed to open `<base>-ruby-guides.json`. A (volume, form) is annotated when three things
hold in **that volume's own copy**: the form has **exactly one** guided reading there, it is guided **as many
times as the book prints it** there, and it is guided **no more than `VIEW_MAX_USES_PER_VOLUME` (2)** times
there — unless the caller names that form a rename, which is the only way past the bound. The middle guard is
the one §2.12 does not carry, and it is the one that keeps the view honest: the extracted text records no guide
*positions*, so without it a view would print readings over words the author guides only sometimes, and measured
against the real filing that means **43,244 invented guides** against 21,082 real ones. The bound is per volume,
not series-wide. The result is **4,497 pairs / 5,546 occurrences / +145,054 characters (5.92%)**, not the
4,808 / 6,739 / +192,251 this section was written with. The markup is one shape,
`<ruby>蒲田<rt>かまた</rt></ruby>`, emitted by a single longest-match left-to-right scan that never reads its own
output, so `stripRubyMarkup(annotate(text)) === text` holds on all 133 real chapters; a chapter already carrying
ruby is refused rather than annotated twice. **No stage calls the view.**

### 4.6 Normalise before you compare, and teach the parsers first

- A quote is stripped of ruby markup before it is checked against the book, and the extraction prompt says
  to quote the word as printed without the reading.
- `parseVoiceMarkdown`, `parseGlossaryMarkdown` and the render round trips are taught to survive ruby
  markup **before** any published file is allowed to contain it. The order matters: a parser that meets
  markup it does not understand produces a corrupted claim body with no finding and no count that moves.

**How this was built (slice 5, 2026-10-15).** The strip is one function, `utils/reference-store/ruby-markup.js`,
wired into `normalizeQuote` and `quoteSkeleton`, so every citation door in the repository inherits it —
`insertFact`, `verifyStoredEvidence`, both revision doors, the confirmation door, the span-close door — and the
search helpers report `markupStripped: true` when they used it, so "the quote needed stripping" is a fact on the
record rather than an accident. The teaching is **behaviour-preserving by measurement**: no published file in the
corpus contains a `<ruby>` tag today, so every parser change is proven by planting markup in a fixture and
showing the old damage and the new answer side by side. The damage is specific — `parseVoiceMarkdown` treats any
non-bullet line after the first bullet as a continuation of that bullet, so a guide standing on its own line
under a heading was glued onto the claim above it and became part of a published claim's body. The taught rule
refuses **only** a line carrying markup and still glues an ordinary wrapped line, which is what keeps it a rule
about markup rather than a rule about line breaks. **What was not built is the prompt half of the first bullet**:
no prompt file mentions ruby today (measured: 0 of the 43 files in `system-prompts/` and `user-prompts/`), and
none needs to while
every quote a model can produce comes out of guide-free extracted text. The instruction becomes necessary the
moment a model is *shown* an annotated chapter — which is §6.6's decision, not this slice's.

### 4.7 The glossary labels

`Original` / `Translated`, the owner's wording, decided 2026-10-15. One door writes the heading; three
readers drop it by position. Rename it, re-render the 17 published files from the record (0 model calls),
and re-measure the render against what is on disk first — an earlier comparison found volume 01 identical
but volumes 02 and 17 losing rows the evidence rule had refused, and that must be known before it happens,
not discovered afterwards.

### 4.8 Notes in the source language

Built here; **paid for later**, on the owner's clean-run timing. Building it means two things at once:
the prompt asks for source-language notes, and the terminology-settlement agenda — which currently builds
its agenda by reading **English phrasing** in notes ("revealed later", "turns out to be", future tense) —
is re-taught, or it silently reports an empty agenda against a source-language glossary.

### 4.9 The source book is allowed to be wrong

The owner's answer on the near-miss names was "treat them as typos made by the author or the editing staff",
and then the wider and more important half: *"not sure if the glossary step already has something in place
that accounts for the possibility of typos and grammatical errors being in the source material, but if it
doesn't, it should be added somehow."* **It does not.** The only two places the word "typo" appears in this
repository's instructions are a 🟢 nitpick in the wiki validator's severity ladder and one example in the
consistency audit's severity rules, and both are about the artifacts this pipeline writes, not about the
book it reads. `findRenderingVariants` scans the **translation's** spellings. So today, a book that guides one
name two different ways in the same chapter, and a series that writes 偽物 both ways, reach the translator with
nothing said about either.

Two deterministic reports, both built from rows the record and the extraction already hold, both filing
nothing:

- **Variant spellings.** Two written forms under one guided reading where **at least half of the shorter one
  survives inside the longer** — 偽物 / 偽者, 我侭 / 我儘, 太股 / 太腿, 貴方 / 貴女, 振動 / 震動. Measured:
  **25 of the 79 unselected groups.** Printed the way a dictionary prints *color* / *colour*: both spellings,
  both counts, no verdict.
- **Inconsistent guidance.** The author guides **one written form two or more different ways in the same
  chapter**, where the two readings are **the same characters in a different order**. The real case is in the
  harvest already: 三色院董子 guided さんしよくいん**すみれ**こ and さんしよくいん**すれみ**こ in the same
  chapter — a reading whose moras are transposed, **1 row in 10,005**, and **1 defect across all 17 books**.
  It is reportable because the author's own two answers disagree, not because a count looks odd.

**The wider shape this section first named is not a defect class, and the measurement is what said so.** The
plan asked for a second shape — "one guided reading printed over two written forms in one place". Run over the
corpus (slice 2b, 0 model calls) it fires **309 times**, and **it fires on 董子 four times**: volume 16
chapters 3, 4, 5 and 5.1 print すみれこ over 菫子 ×57 and 董子 ×10, which is the spelling §2.11(b) withdrew as
a defect. Sorted, those 309 are **195** rows the group guards refuse, **14** the identity door already files,
**56** the variant-spelling report already prints, and **44** the sound-alikes §2.10 measured as **not errors**.
**Nothing in that shape is a defect the other doors do not already describe**, so the anomaly class is the
transposition and the wider numbers are printed as counts, not as findings.

**Concentration is not the signal, and this plan said it was.** §2.11(b) originally published 董子 — 92
occurrences, **75 of them in volume 17 chapter 6**, against 菫子 646 across 11 volumes, 菫 U+83AB / 董 U+8451 —
as "a bad file, not a name". **That diagnosis is withdrawn** (gotcha 168): the same harvest guides 董子 as
すみれこ **76 times in chapters 5 and 6** of that volume, chapter 6 is 第六章 俺とお前の始まり (a flashback),
volume 17's published Characters table already holds 董子 and 三色院董子 with its own note saying the spelling
is what the flashback uses, it is guided 3 times in volume 15 and 10 in volume 16, and in that volume's own text
董子 is printed 79 times against 菫子's **7**. A pronunciation guide is an authorial act, so a name concentrated
in one chapter is what **an arc set under another name** looks like in a count. A detector built on concentration
would have reported a real name as a source error and missed the transposed reading beside it.

**What the rule must not be.** "One form at least 10× more common than the other under the same reading"
selects **132 candidate pairs** on this corpus and most of them are single-mora guides — 込 / 子 / 木 all
read こ, 尽 / 着 / 吐 all read つ. Frequency alone is not a detector, and neither is uneven spread: 如雨露
(1–2 per volume across 8 volumes, against 如月雨露 281 times across 16) has to come back **silent**, because a
name written short in every book is not a corrupted chapter, and neither is 董子.

**And the near-miss names are not typos.** §2.11 shows サンちやん, チエリー and ジヨーロ appear **0 times**
in the extracted text: they are ruby readings, and the roster's spellings are body text. The store already
folds small kana (`foldSmallKana`) and already files those as near misses rather than links; it is missing
one entry, ェ → エ, which is why チェリー / チエリー does not resolve. The fold stays a reporting rule —
gotcha 121 is about exactly what happens when a spelling rule is allowed to decide a name match.

---

## 5. The slices, in build order

| # | Slice | Acceptance line |
|---|---|---|
| **0** | **BUILT 2026-10-15 — the corrected guide measurement.** `utils/source/guide-groups.js` reads a harvest and produces candidate groups; `test/test-guide-groups.js` (94 checks, fixtures only) pins the rule; `test/measure-guide-groups.js` re-runs every number in §2 over the live corpus with 0 model calls and writes nothing. | **Met, and three of the plan's own numbers moved.** §2.1–§2.3 are reproduced by a script that reads only the guide files, 0 model calls, and a test fails if the *rule* moves. The corrections: the "24 readings over more than one written form" is **14** (24 counted volume-and-form pairs), the パンジー group spans **10** volumes not 12, and 三色院菫子 → パンジー is **18 occurrences series-wide, 16 of them in volume 15**. Plan 06 §2.11's retired conclusion is named as retired, not deleted. |
| **1** | **BUILT 2026-10-15 — written forms become recorded facts, and no claim about anyone.** `utils/reference-store/written-forms/` (`shapes.js` 302, `rows.js` 301, `file.js` 368) behind a `written-forms.js` cover (77, 22 exports, 0 name clashes with a sibling layer), re-exported from the store barrel (369 → 391 exports). Schema **11 → 12**: `written_forms`, one row per `(volume, form, reading)`, insert-only, out of `UPDATABLE_FIELDS`, in `COUNTED_TABLES` (19 → 20) so copy-forward carries it. `test/test-written-forms.js` (10 scenarios / **166** checks, fixtures only) is in `npm test`; `test/measure-written-forms.js` (427 lines) is not. | **Built, and the plan's own acceptance line turned out to be unmeetable as written — see §2.13.** What is measured: the door files **240 rows** across the 17 volumes (**57** groups regrouped, **3,196** occurrences), a second pass over volume 17's copy files **0** and reports 13 already filed, the roster rule run against a copy of volume 17's 196-entry roster selects **18 groups / 134 rows / 1,402 occurrences** and leaves **79 / 500 / 7,332**, and the 25 / 54 split reproduces exactly (**25 variants / 166 rows / 1,561 occurrences**, **54 sound-alikes / 334 rows / 5,771**, **0 false positives** — it calls 美味/上手, 披露/疲労 and 俺/脇役 nothing). **No stage calls the door** (2 callers, both tests); **nothing else reads `written_forms`** (only the migration and those two tests); the identity layer is not required by it; the 17 corpus digests and 17 + 17 sidecars are unchanged and **0 `written_forms` rows exist in the corpus**. Every call baseline unmoved (82 / 17 and 28 / 6, 0 on the second pass in both, prompt audit 23 / 0), no new finding kind (70), no new freeze door (12), no new setting, no new command, 0 model calls. What moved: `test/test-identity-table-isolation.js` **496 → 499** (it counts tables off `sqlite_master`), and three tests that hard-coded schema 11 now pin 12. **§6.7 is answered (2026-10-15): the filing scope widens to every harvested row that passes the two *row* guards (≈8,910 rows) and the group question is answered by query**, so the 240-row / 57-group numbers above are the narrow scope this slice first built, not the scope it ends with. |
| **2** | **BUILT 2026-10-15 — identities carry the forms, with the roster-or-reading rule.** Two forms guided to the same reading join one identity, **for the 18 groups §2.9 selects**. Statements only — no claim ever moves. The small-kana fold stays a **reporting** rule (gotcha 121), gets the one missing table entry so チェリー / チエリー resolves. **The instruction that 董子 is "reported as an anomaly, never as a link" is withdrawn** — §2.11(b) was measured again and the diagnosis was wrong, so the すみれこ spellings are a true link the rule must not be made to exclude. | On a copy of volume 17's record: パンジー's group contains the forms in §2.3 and is reachable from a query. `cast_merges` stays 0. A planted claim stays under the form that filed it. **The rule must not require one form to be unknown** — §2.9 shows that half throws away さんしよくいんすみれこ and つきみ. All three near misses are named, including チェリー / チエリー. The 18 groups arrive **in full** through the cumulative record (§2.13), which is what the owner's scope answer bought. |
| **2 — verdict** | **Met, and two things the store's own shape refuses** (measured 2026-10-15, `test/measure-identities.js`, 0 model calls, copies only). | The door now reads the record's own `written_forms` rows through `candidateGroupsInRecord`; it no longer opens a volume folder and no longer knows the harvest file's name. The guide half states **every unordered pair** of the names one selected group holds that the roster publishes, dated to the **later** of the two names' first volumes (月見 guided つきみ in volume 4, 草見月 in volume 11 → volume 11 is the book that completed the pair). **§2.9 reproduces exactly:** 97 groups / 222 forms / 634 rows / 8,734 occurrences, of which **18 identity-bearing / 134 rows / 1,402 occurrences**, **79 left out, 0 false positives**. The door files **71 links from 87 stated pairs** (15 from the record's written forms, 72 from published Characters rows, 16 already filed), creates 35 identities, absorbs 1; a second pass files **0** and reports 75 already filed. Roster shape: 196 entries → **34 identities, 88 linked, 54 duplicates, 108 unlinked, largest group 6** (plan 06 §8 predicted 35 / 91 / 56 / 105 / 6 — same shape, one group different). Old rule vs new: **11 of the old 13 pairs kept, 4 only the new rule finds** (三色院菫子 / 虹彩寺菫, 三色院菫子 / 三色院董子, 桜原桃 / 桜桃, 月見 / 草見月), **2 dropped** and named. `cast_merges` **0** in all 17 copies; 0 identity rows exist in the corpus. **Two things the acceptance line asked for and the store's own shape refuses**, both written up rather than worked around: a link is a foreign key to `cast(key)`, so **5 of the 18 selected groups hold exactly one published name and file nothing** (すみれこ ← 菫子 ×371 / 董子, なでしこ ← 撫子 ×105 / 赤井撫子, サンちやん, ツバキ, ミント ← 薄荷 / 自分の彼氏) — they are named in `guideUnlinkedGroups`; and a guide over a **single** written form is never a candidate group, so リリス / 炭印嵐 and アネモネ / 牡丹一華 are named in `guideSoloRosterPairs` and filed nowhere. Both are §6.8 and §6.9 below. |
| **2b** | **BUILT 2026-10-15 — the source book is allowed to be wrong, and saying so is a door.** Two deterministic reports built from rows the record already holds: **variant spellings** — the 25 groups §2.10 measures, printed the way a dictionary prints *color* / *colour* — and **inconsistent guidance**: one written form guided two different ways, or one reading printed over two spellings in one place (三色院董子 guided さんしよくいん**すみれ**こ and さんしよくいん**すれみ**こ in the same chapter). Filed nowhere, declared nowhere, 0 model calls. **Concentration alone is not the signal** — §2.11(b) shows a form the author guides 76 times in one flashback chapter is a name, not a defect, and a detector built on uneven frequency would report it as one. | The variant report reproduces the 25 groups and names both spellings with their counts. The anomaly report finds the transposed reading and **does not** find 董子 (guided, flashback, already on the roster) or 如雨露 (spread 1–2 per volume across 8 volumes, a name written short). The 54 sound-alike groups are named as a class and **not** reported as errors. A planted fixture of each shape fires, and a fixture of the wrong shape stays silent — including 込 / 子 / 木, which the naive "10× more common" rule wrongly flags. |
| **2b — verdict** | **Met, and the acceptance line itself was wrong** (measured 2026-10-15, `test/measure-source-quality.js`, 0 model calls, copies only). | Two report doors in the written-forms layer (`reports/collisions.js` 448, `reports/records.js` 484, `reports/variant.js` 194, `reports/guidance.js` 250) behind the existing cover (95 → 145 lines, 23 → 46 exports, store barrel 391 → 417). **The variant report reproduces §2.10 exactly:** 97 groups → 18 the roster selects, 79 it cannot see → **25 spelling variants / 166 rows / 1,561 occurrences** and **54 sound-alikes / 334 rows / 5,771**, gap 0. **The acceptance line and the shape as written cannot both hold**, and this is the slice's finding: shape (b) — one guided reading printed over two written forms in one chapter — **fires on 董子 four times** (volume 16 ch3 / ch4 / ch5 / ch5.1: すみれこ over 菫子 ×57 and 董子 ×10), which is the spelling §2.11(b) withdrew as a defect. Measured widths: **215** loose (volume, form) pairs, **244** same-chapter form collisions (142 pairs, 71 forms), **309** same-chapter reading collisions (181 pairs, 81 readings), sorted 195 not-a-candidate-group + 14 identity-bearing + 56 spelling-variant + 44 sound-alike = 309. **The anomaly class is therefore narrowed to the one discriminator that fires on the plan's real defect and on nothing else: the same characters in a different order.** It names **1 defect** across the 17 books — volume 17 ch5, 三色院董子 guided さんしよくいんすみれこ and さんしよくいんすれみこ — and **0** on the mirror shape. 董子 is named exactly **0** times as a defect (its 4 すみれこ collisions are counted and land in the identity bucket); 如雨露 appears in **0** collisions of any shape; 嫌 guided いや/きら/ぎら is counted and called nothing. The rejected 10× rule, run against the same rows, flags **39 collisions over 31 readings** and finds **0 of the 1 defect** — it compares spellings, and the defect is one spelling read two ways. Idempotent: a second pass writes **byte-identical** files; **no row written anywhere** (`cast_merges` 0, both identity tables 0, challenges 0), 0 `written_forms` rows in the corpus, all 17 digests and 34 sidecars unchanged. **Unwired: 0 callers outside the layer.** `test/test-source-quality-reports.js` (10 scenarios, **179 checks**) is in `npm test`; `test/test-written-forms.js` **210 → 211** (it now names the one door outside the layer allowed to ask the grouping question). **Two things the measurement says that the plan did not know:** the 25 variant groups are **not** all one word spelled two ways — **16 of the 25 are decided by a single shared character out of two**, and three name different things (小原 ×2 / 小腹 ×1 across three books; 凍気 / 闘気, two in-world terms in volume 5; **三上 / 魅上**, both in volume 16, one character apart) — and 三上 and 魅上 are **both real and distinct in that volume's own published glossary** (the voice actress 三上枝織, and 魅上照 from another series), so publishing "also written 魅上" beside 三上 would be the note inventing a spelling. §6.4 cannot be answered from the count of 25. And **§6.5 now has its number: a class of one.** |
| **3** | **BUILT 2026-10-15 — the relations table, and a span that closes only with a reason.** `utils/reference-store/relations/` (`shapes.js` 430, `rows.js` 432, `file.js` 708) behind a `relations.js` cover (117 lines, **35 exports**, 0 name clashes with a sibling layer), re-exported from the store barrel (**417 → 452** exports, 0 lost, 0 shadowed). Schema **12 → 13**: `relations`, 25 columns, `relation_id` a surrogate key, `addresser` / `addressee` foreign keys to `cast_identities(identity)` and nullable, four `CHECK` vocabularies repeating the four lists in `shapes.js` name for name, `idx_relations_key` unique over `(established_volume, channel, form_used, ifnull(addresser,-1), ifnull(addressee,-1))`, in `COUNTED_TABLES` (**20 → 21**) so copy-forward carries it, and **no column added to any existing table**. `test/test-relations-table.js` (12 scenarios / **264** checks) and `test/test-relations-isolation.js` (7 scenarios / **199** checks) are in `npm test`; `test/measure-relations.js` (412 lines) is not. | **Met, on fixtures and on copies.** A planted development closes an earlier span **in the later volume's own copy**, and the earlier volume's file is **byte-identical** afterwards and still reports its span **open**; a volume-2 row is invisible to a read of volume 2's record asked "as of volume 1", which is the same rule from the other side. A close naming no chapter, no line, or a line the closing volume does not print is **refused and stores nothing**. A close moved **7** columns and left all **18** content columns byte-identical, through the layer's single `UPDATE`, which is **generated from `RELATION_CLOSE_COLUMNS`** rather than hand-written beside it. **Two deviations from §4.3's column list, reported rather than hidden:** `closed_by_line` and `closed_at` were added (every other citation in this store records the line it was found on, and a close is an act with a date), and `valid_from_volume` is kept **equal** to `established_volume` with the equality pinned in a test. **§6.8's wall is now a number:** on a copy of volume 17's record built up to §2.9's shape, the door can key **88 of 196** names and must name **108** as limits — 25 of those 108 were offered to it directly, and all 25 were refused with **0 roster entries and 0 identities invented**. **Unwired:** 0 callers outside the layer and its tests, 0 readers of the table, 0 model calls, no new finding kind (70), no new freeze door (12), no new artifact, command, setting, environment knob or verb on the store's handle, and **0 characters of any one language's script anywhere in the layer** — scenario 11 runs the whole door against a non-Japanese fixture. Every call baseline unmoved. What moved: `test/test-identity-table-isolation.js` **547 → 550**, `test/test-identity-table.js` **166 → 167**, and six places that pinned schema 12 now pin 13. |
| **3 — verdict** | **Met, and the acceptance line is the easy half.** The three things §5's row asked for are all pinned by a test that runs the real door against a real fixture record, and the measurement that matters is the one the acceptance line did not ask for: **what the table can be keyed on, on this corpus.** | The plan's line — "a planted development closes an earlier span in the later volume's copy and leaves the earlier volume's snapshot byte-identical" — is measured twice: once on a fixture pair built the way `copyForwardStore` builds one (`test/test-relations-table.js` scenario 6), and once against **two real records** (`test/measure-relations.js` §4): volume 16's copy is `e6a7f851b277` before and after everything volume 17's copy did. **What the plan did not say is that the door is unreachable on this corpus as it stands**, for the same reason slice 2's door was: all 17 corpus records hold **0 `relations` rows, 0 `cast_identities` rows and 0 `cast_identity_links` rows**, because neither door is wired into a stage. Reproducing §2.9's roster shape on a copy therefore means running the written-forms door (8,910 rows) and the identity door (71 links, 35 identity rows) on the copy **first** — and the honest corpus statement is "planted against a copy", not "read from the books". **The number that changes how slice 4 should be scoped:** 34 live identities over 196 roster entries means the relations door can key **88 names** and must name **108** as limits, so a reading pass that produces acts of address will have nowhere to put roughly half of them until §6.8 is answered. **And one thing the acceptance line asked for that the store's own shape refuses:** a party is a foreign key to `cast_identities`, so a name with no identity is not a party at all — the door could have widened the key to a roster key and filed it, and §4.3 says not to, so it files nothing and says so. |
| **4** | **BUILT 2026-10-15 — an act of address is a kind in the chapter call that already runs.** `utils/reference-store/relations/contract.js` (651 lines) is the contract: the entry kind, the §4.4 ladder computed by code, and the pass that files through the door slice 3 built. It sits behind the existing `relations.js` cover (**117 → 142** lines, **35 → 44** exports, store barrel **452 → 461**) and is called from **one** place outside the layer — `utils/reference-store/rebuild/filing.js` (616), after the claims and after the confirmations, which is the door both the stage route and `rebuild-voice.js` walk through. `utils/reference-store/extraction-adapter.js` (565) recognises the kind and files nothing. `character-voice/stages.js` (345) carries the entry keys **13 → 18** (`channel` / `addresser` / `addressee` / `formUsed` / `statement`) and **`certainty` is deliberately not among them**; the answer schema stays open. `system-prompts/character-voice-extract.md` asks for the fourth kind in text only, and `character-voice/assemble.js` (326) prints what the pass reported. **No table, no schema bump (13), no new finding kind (70), no new freeze door (12), no command, no setting, no environment knob, no verb on the store's handle, nothing downstream reads the table.** `test/test-relation-contract.js` (10 scenarios / **144** checks) joins `npm test`; `test/test-relations-table.js` **264 → 265**, `test/test-relations-isolation.js` **199 → 205**, `test/test-answer-envelopes.js` **233 → 255**. | Pass 1 files relations, pass 2 over the same fixture pays 0 calls. A planted "the name in the quote is the addressee" case comes back `addressee-risk`, not `measured`. A chapter that names nobody files nothing and is named, not punished. |
| **4 — verdict** | **Met, and the ladder is the finding** (measured 2026-10-15, `test/test-relation-contract.js`, 0 calls to the endpoint, fixtures only; the corpus numbers from a probe run against **a copy** of volume 17's record — gotcha 124). | The acceptance line is four numbers: pass 1 pays **4** chapter calls and files **6** relations, pass 2 pays **0 calls**, files **0**, reports **6 already filed**; the planted swap comes back **`addressee-risk`** and it is in the **table**, not only in the report (2 planted `spoken` acts → 1 `measured`, 1 `addressee-risk`); a chapter that names nobody still files its narration act and is **named** in the report — 1 chapter named for naming nobody, **3** named for reporting nothing, **0** findings, and re-filing the same act files nothing while the audit says exactly what it said before. **What the ladder turned out to require, and where it is stricter than §4.4's wording:** `measured` needs the cited line to name **exactly one** cast form, that form to resolve to the **addresser's** identity, and the addressee to be a **different** identity. §4.4 says only "it is not the person being spoken to", so a line whose one cast form belongs to a **third** person satisfies the plan's sentence and is refused by the build — planted, and it comes back `null` with the reason "neither party". A **self-address** whose two sides are already one identity therefore cannot be `measured` either: it reaches `reading-resolved` only if the book's markup states the link, and is otherwise named unlevelled. `addressee-risk` is checked **before** the guide rung, because a line whose one cast form belongs to the addressee is a wrong answer the markup cannot overrule, and the same failure seen from the other side — `formUsed` is itself a form of the addressee — is the same level with `via: "form"`. `reading-resolved` rests only on a link the record already holds, so it does **not** need a verified line, which is what the door's own precondition agrees with. Nothing firing is **not filed** and there is **no fallback level**: every failed rung is listed in order (3 of them in the planted case). The gap levels come straight from the entry shape — the ladder is never asked of `narration` or `withheld` — and all three file with a null addresser, naming a **party kind** instead of a name, with **0** roster entries and **0** identities invented. **The wall is slice 2's and slice 3's wall, now measured where a reading pass actually hits it:** on a copy of volume 17's record — 196 roster entries, **0** identities, 0 written forms, because the identity door is still unwired — 4 planted acts produce **1 filed** (the narration one, which needs no person), **1 named limit** (`relation-party-not-in-an-identity`, the addressee is on the roster and unlinked) and **2 unlevelled**, with `cast` 196 → 196, identities 0 → 0, links 0 → 0 and `facts` 2,063 → 2,063. On the corpus as it stands, **only an act that names no person can file**; every act naming a roster name is a named limit until §6.8 is answered and the identity door is wired (§10.9's question, the owner's). **The isolation guard had to be re-scoped, not widened**, and the re-scope is the honest one: 25 protected module layers keep the whole ban, while `rebuild.js` and `extraction-adapter.js` move into a named `RELATION_AWARE_MODULES` allow-list under a narrower whole-word ban, a ban on reaching inside `relations/rows.js` / `file.js` / `shapes.js`, and the table-read ban kept — with a **tree-wide scan** proving **0 unnamed producers** over 449 pipeline files, which is what stops the allow-list from being a loophole. **Nothing else notices:** two identical fixture records, the acts filed in one, come back with the same claims, characters, refusals and candidate copies, every table identical row for row except `relations`, a **byte-identical** published reference, identical audit findings and an identical known-facts block. **Every call baseline unmoved** — 82 / 17 and 28 / 6, **0 on the second pass in both**, prompt audit 23 / 0 — and all **17 corpus digests plus 17 + 17 sidecars unchanged**. What moved is prompt size: the largest `voice-extract` prompt **14,702 → 16,964** characters in the main loop and **14,636 → 16,898** in the chunked one, which is the price of asking for the act in the same call rather than paying for a second one; `acceptance` unmoved at 12,103 / 12,916. **One deviation from the slice's own brief, reported:** the reading pass already names a chapter that names nobody, so `character-voice/reading/volume.js` and `reading/read-report.js` were left untouched and the per-chapter relation facts come from the contract's own report plus a new `addressed —` line in `assemble.js` — a second place saying the same thing would be two places to keep in step. |
| **5** | **BUILT 2026-10-15 — normalise, teach, then show, in that order.** `utils/reference-store/ruby-markup.js` is now the store's **one** rule about HTML ruby: strip (`<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>` → 蒲田, by guide-tag depth, so nested ruby works and an unbalanced tag keeps the word), build (the one shape `<ruby>蒲田<rt>かまた</rt></ruby>`, and `RUBY_MARKUP_OVERHEAD_CHARS` = 22 so a view's price is computable), recognise (`hasRubyMarkup` / `rubyMarkupUnitCount`). It is a **pure leaf** requiring nothing but the types, and its tag vocabulary is **pinned equal to the converter's** `RUBY_GUIDE_TAGS` by a test rather than imported, because `utils/source/html.js` loads `cheerio` at require time (gotcha 119's reason). **Normalise:** the strip is wired into `normalizeQuote` and `quoteSkeleton`, so every citation door in the repository — `insertFact`, `verifyStoredEvidence`, the two revision doors, the confirmation door, the span-close door — strips a guide before it compares, and `prepareQuoteForSearch` / `verifyEvidenceItem` / `verifyEvidence` / `searchSpans` / `findQuoteEvidence` all report **`markupStripped`**. **Teach:** `parseVoiceMarkdown` (a heading is the word, a guide on its own line is **not** a continuation of the claim above it, a markup-bearing bullet is kept verbatim and named → `annotatedLines`), `glossaryTermSpans` in **both** readers (`glossary-adapter/parse.js` and `glossary/carry-forward/table.js`, which now requires the leaf) stripping **before** splitting on `/`, and `parseGlossaryMarkdown` stripping a `## ` label and reporting `annotatedRows`. **Then show:** `written-forms/view/select.js` (`VIEW_MAX_USES_PER_VOLUME = 2`, three guards, the rename half supplied by the caller), `view/render.js` (one longest-match scan over the input, never over its own output), `view/chapter.js` (the door a caller would use). **No stage calls it** — 0 callers outside the layer, pinned by a tree walk — 0 model calls, no new table, no schema bump (13), no finding kind (70), no level, no freeze door (12), no command, no npm script, no setting, no knob, no verb on the store's handle. | The wrong order is proven to be the wrong order: a test shows a parser meeting un-taught markup gluing a line onto a published claim's body, and shows the taught parser not doing so. The annotated view adds the §2.12 set (4,808 forms / 6,739 occurrences, +192,251 characters measured) and nothing else, and a quote copied out of an annotated chapter still verifies against the guide-free stored text. |
| **5 — verdict** | **Half met, and the acceptance line's own number is wrong** (measured 2026-10-15: `test/test-annotated-view.js` **203 checks**, `test/measure-annotated-view.js`, 0 model calls). **Met.** The wrong order is proven to be the wrong order: the suite prints the glued shape — a published claim body reading `「…！」 <ruby>蒲田<rt>かまた</rt></ruby> is named here with its guide.` — beside the taught parser recording that same line as `line-not-glued`, **and an ordinary wrapped line is still glued**, so the rule is about markup and not about continuation. A quote copied out of an annotated chapter verifies **verbatim** against the guide-free fixture chapter with `markupStripped: true`; a forged quote carrying markup is still refused; the wrong line number is still refused, with the right line named. `stripRubyMarkup(annotate(text)) === text` holds on **all 133 real chapters** (0 failures), and the corpus is untouched (17 digests unmoved, 34 sidecars intact, **0** written-forms rows in the corpus's own record, which is at schema 8 and has no such table). **Not met — and it is §2.12's row that needs correcting, in three places.** (1) **The character column is not reproducible from any markup shape this repository could emit.** One annotation costs `<ruby></ruby>` + `<rt></rt>` = 22 characters plus the reading; over §2.12's own 6,739 occurrences that is **176,271**, not 192,251, and a search over per-occurrence / per-piece / per-reading-character costs and six alternative markup shapes found **no** model fitting all four of §2.12's rows (best fit 20·occurrences + 2·characters, 1.7% worst error). (2) **"the series uses that word no more than twice" is not a series-wide count**: counted per volume the always-guided-within-the-bound set is **4,712** pairs / 5,830 occurrences — **4,606 / 5,706** once the 202 renames are taken out, which is where 4,808 comes from, as the union — while counted across the whole series it is **1,898** pairs (1,831 without the renames). (3) **The equality guard is load-bearing and §2.12 does not carry it.** The extracted text records no guide **positions**, so a form guided fewer times than the volume prints it cannot be annotated at every printed occurrence without inventing guides: **2,532 forms, 21,082 guided against 64,326 printed — annotating them all would print 43,244 guides the author never wrote** — over the whole harvest, before the store's row guards, the same rule is **3,322 of the 9,663 pairs, 26,178 guided against 100,354 printed, 74,176 invented** — and the clearest case is §2.12's own headline rename, 三色院菫子 guided パンジー 18 times against 646 printed, because a rename happens *at a point in the story*. **What the shipped door actually produces:** **4,497 (volume, form) pairs / 5,546 guided occurrences / +145,054 characters (5.92% of 2,450,316)**, of which **98 pairs / 123 occurrences** are renames the caller named; refusals **215 guided several ways / 2,532 not guided every time / 1,440 used more than twice**; the rendered set over 133 chapters equals the selected set exactly. **And the rename half is not a rule this layer holds.** §2.12's renames are "a Han word guided with a reading written in one particular foreign script", and only a **katakana**-keyed classification reproduces §2.12's 202 pairs / 1,033 occurrences — every script-neutral alternative selects 3,069–9,642 pairs — so the classification is **caller-supplied data** (`renameForms`), which the measurement supplies from the record's own `reading_script` column, while `select.js` names no writing system (pinned by a scan, and by `test/test-no-language-axis-list.js` at **0 findings** over 453 pipeline files). Whether that classification belongs to the plan of record, to a stage, or to nobody is **§6 question 11**, the owner's, and it is written in `/tmp/opencode/plan07-slice5-questions.md` rather than decided here. **And one bullet of §4.6 is not built:** no prompt file mentions ruby (0 of the 43 in `system-prompts/` and `user-prompts/`), so the instruction "quote the word as printed, without the reading" is not in any prompt — it becomes necessary only once a model is *shown* an annotated chapter, which is §6.6's decision. **Every number in this verdict is printed by `test/measure-annotated-view.js`**, which now recomputes §2.12's four rows from the 17 harvests, prices each with the markup shape the renderer emits, and **fails its own run** if row 2 stops reproducing 4,808 / 6,739 (1.4 s, 0 model calls, 17 digests unmoved). |
| **6** | **The glossary labels, and a render-only door.** Rename the heading to **`Original` / `Translated`** (the owner's wording), add the door that re-renders a published glossary from its record with 0 model calls, and re-render the 17 files. | The render is compared against what is on disk **before** anything is replaced, and every row that disappears is named with the rule that refused it. No sealed row is edited. The freeze gate is not asked to excuse anything. |
| **7** | **Source-language notes, and the re-taught agenda.** Built and pinned; not run for real. | A fixture glossary renders with source-language notes. The settlement agenda still finds its candidates against source-language notes — measured, not assumed. The paid run is explicitly not taken. |

**Slice 0 is first because everything else reads its numbers.** Slice 2b sits beside 2 because the same
measurement feeds both, and because a rule that groups "two forms guided to the same reading" is exactly the
rule that would file 董子 as a person if nothing named it first. Slice 5 is deliberately after 3 and 4 so
the parsers are taught before any file can contain the markup. Slice 6 is the only slice that touches
published files, and it is placed late so the measurement in §4.7 is done with the rest of the plan settled.

**One change made while scoping slice 1, and why.** This row used to say *file the 18 identity-bearing
groups' forms and report the other 79, filing nothing*. That is not buildable alongside the owner's answer on
the pronoun groups — **record the words, no character** — because those groups (おれ, あなた, あなたたち,
あなたさま, わたし, モブ) are inside the 79 the roster rule cannot see. Filing them would need a rule that
knows what a first-person pronoun is, and this repository carries no such list in any language, by the
owner's own rule. So the scope moved to the half that is computable: **the forms are filed for every
candidate group, and nothing is claimed about any of them.** A written-forms row transcribes the book's own
markup — *volume 9 prints 美味 and guides it with うま* — and asserts no person, which is exactly what
"record the words, no character" asks for. The claim stays where the owner's caution belongs: in the identity
table, which slice 2 fills for 18 groups and no more. The asymmetry the owner named — filing is easy to
extend and effectively impossible to undo — is met by keeping this table unread by every renderer, audit rule
and query until a slice has a reason to read it.

---

## 6. Open decisions, for the account owner

**Answered 2026-10-15 and no longer open:** the two glossary headings (**`Original` / `Translated`**); how
far the annotated view goes (the renames plus the always-guided-and-rare set, §2.12); whether a group made
only of descriptions and first-person pronouns is an identity link (**record the words, no character**);
what to do with the 79 unselected groups (**note the 25 spelling variants, judge the 54 case by case, file
nothing**); and how wide the roster match has to be (**not widened at all** — the three near misses are a
small-kana fold the store already has and already reports, missing one table entry, §2.11).
**Slice 5 built the view this paragraph answers and corrected its arithmetic** (§2.12's correction, §5's
slice-5 verdict): the decision stands, the numbers in it do not, and the built row is 4,497 pairs / 5,546
occurrences / +145,054 characters.

Still open:

1. **Which certainty levels may trigger an investigation.** `addressee-risk` is the interesting one and it
   fires often; the run-wide investigation bound is 3, and one real investigation turn measured 7.2M tokens
   and 12 minutes. A bounded read-only reading pass measured 1 call and 10,530 tokens for a whole volume.
   The threshold is a decision about how much you want to pay to know who is speaking.
   **Slice 4 (2026-10-15) changed what this item is about, and lowered its urgency.** The levels are now
   assigned by code, from the line the citation names and the identities the record holds — never by a model's
   self-report — and on this corpus **`addressee-risk` cannot fire on a real book at all yet**: a party is a
   foreign key to `cast_identities`, all 17 records hold 0 of them, so every act naming a cast member is
   refused before the ladder's level matters and only the three gap levels file. "It fires often" is the
   attribution measurement (10 of 10 in volume 2), not a measurement of this table. The decision is worth
   re-asking after the identity door runs, when the levels exist to be routed.
2. **Whether `withheld` relations reach the translator.** They are a fact with instruction attached —
   *keep this unresolved* — but they live in a record the translator reads, and printing them is a
   decision about what the translator is told.
   **Slice 4 makes `withheld` a row that can actually exist** (it files with no addresser and no identity, and
   the ladder is never asked of it), and **nothing reads it**: no renderer, no audit rule, no chapter block, and
   the published reference is byte-identical with 6 relations filed or none.
3. **Whether the identity door runs per volume or once per series.** Plan 06 §10.9 asked this and left it.
   This plan's recommendation: once per series, as the glossary step's last act, beside the terminology
   settlement — a query, no model calls, its own records, not declared artifacts.
4. **Whether the variant-spelling note reaches the published glossary or only the run's reports.** Slice 2b is
   built and writes **the run's reports only**. Putting "also written 偽者" into a term's row changes 17
   published files, and the freeze gate refuses that once a translation stands on them — today none does.
   **The measurement makes the caution concrete** (§5's slice-2b verdict): **16 of the 25 groups are decided by
   a single shared character out of two**, and three of them name different things — 小原 ×2 / 小腹 ×1 across
   three books, 凍気 / 闘気 as two in-world terms in volume 5, and **三上 / 魅上**, both in volume 16, one
   character apart. That last pair is **already in that volume's published glossary as two separate entries**:
   三上さん is the voice actress who played あすなろ (likely 三上枝織), and 魅上 is a reference to a character
   from another series. So a note reading "also written 魅上" beside 三上 would be the pipeline inventing a
   spelling the author never mixed up. **Recommendation: keep it in the run's reports**, and only revisit if a
   rule is built that can tell 貴方/貴女 from 三上/魅上 — which is a name-identity question, not a string one.
5. **Whether a source-quality anomaly is allowed to stop a run.** The example this item was written with — 董子,
   75 occurrences in one chapter — turned out to be a name the author guides 76 times (§2.11(b)), so it is not a
   defect and this decision has lost its only real case. **Slice 2b has now run over the real corpus and printed
   the number this item asked for: the anomaly class is one.** One transposed reading in 10,005 harvest rows
   (三色院董子 guided さんしよくいんすみれこ and さんしよくいんすれみこ in the same chapter), **0** on the wider
   shape once its 309 collisions are sorted, and **0** false positives across 17 books. The wider counts are in
   `source-inconsistent-guidance.json` so the question can be re-asked against the same rows. Nothing today
   reports the transposition and nothing today could have. Whether an inconsistent guide is a NOTE, a MINOR to
   investigate, or a MEDIUM the extraction step prints is a decision about the level table, and the level table
   is a banned patch path — so it is asked, not made. **A level for a class of one is a different decision from a
   level for a class of two hundred, and it is now a class of one.**
6. **Whether the phrase glosses reach the translator, and as what.** §2.12's rare end is full of the author
   writing a *meaning* over a whole string (達の戦いはこれからだ → 強制終了, あちら側の皆様 → 読者,
   アリーヴェデルチ → さよなら). The chosen rule catches them, but they are not pronunciation, and showing
   them as ruby is a different thing from showing a reading. Markup, note, or nothing, is worth deciding
   before slice 5 is built.
   **Slice 5 is built (2026-10-15), and it settles the cost while leaving the destination open.** The markup
   exists — `renderAnnotatedChapter` prints `<ruby>form<rt>reading</rt></ruby>` over a chapter — and **no stage
   calls it** (0 callers outside the layer, pinned by a tree walk), so the translator is shown nothing today and
   "as what" is still the owner's to answer. What the slice measured is what each option costs. The shipped rule
   annotates a written form **only where the author guides that form every single time it appears in that
   volume**: **4,497 (volume, form) pairs, 5,546 occurrences, +145,054 characters — 5.92% of the 2,450,316 the
   series holds** (§2.12 printed 4,808 / 6,739 / +192,251 = 7.8%; the gap is measured and named in §5's slice-5
   verdict, and it is a correction to this plan's arithmetic, not to the rule). Of that price, **122,012
   characters are the markup itself** (5,546 annotations × 22) and **23,042 are the readings the author wrote**
   — 0.94% of the source. The phrase glosses §2.12 is
   worried about **are in that set** — they are exactly the always-guided, at-most-twice forms — and what the
   markup cannot do is tell a **reading** from a **meaning**: the tag is the same tag, and the only thing that
   can is the rename list, which is item 11. So the honest options are: **(A)** the view as built, available to
   a person and wired to nothing; **(B)** wire it into the translator's chapter block, which pays +5.92% on
   every chapter prompt and prints a gloss as if it were a pronunciation; **(C)** wire it only for the
   caller-named renames — **98 pairs / 123 occurrences** on this corpus today, which is **2,706 markup
   characters plus the readings** across the whole series, the narrowest thing that still tells the translator
   "this name means this" and the option this slice recommends.
7. **ANSWERED 2026-10-15 — what the written-forms door files: every guide row, and the group question by
   query.** Slice 1 was built on the narrowest reading — each volume files its own harvest's candidate groups — and
   §2.13 measures what that costs: **240 rows / 57 groups**, against the **634 rows / 97 groups** the
   grouping rule finds when all 17 harvests are folded together, with **three of the 18 identity-bearing
   groups never filed at all**. The three doors are: **(A)** volume N folds harvests 1..N and files every
   candidate row of that fold — reaches the plan's numbers exactly, and gives up "each volume files only its
   own harvest" in plain words; **(B)** what is built now — files the least, and loses 40 groups and 394 rows
   unless the harvest files are re-read; **(C)** file every harvest row that passes the two *row* guards
   (**≈8,910 rows**, 14× what B files) and answer the group question **by query**, which satisfies both
   clauses and is the only one that keeps the grouping guards' measured false negative (しば ← 芝 ×416 /
   縛 ×10) recoverable without re-reading the books. The seam is left in place so this is a call-site change
   and not a rewrite: `fileVolumeWrittenForms(store, { harvests })` already accepts pre-read harvests and
   refuses any later than the volume being filed, and `candidateGroupsInRecord(store, { upToVolume })`
   already answers the group question over the rows a record carries. **The owner chose C 2026-10-15: file every harvested row that passes the two *row* guards, and answer the
   *group* question only by query, never at filing time.** The measurement that decided it is the blind spot:
   the grouping guards are arguable, they already dropped しば ← 芝 ×416, and a door that applies an arguable
   judgement **when it files** is a door that makes that judgement impossible to widen later. Filing stays
   per-volume and judgement-free; grouping is a read. **Slice 2 is unblocked**, and it reaches the table through
   `candidateGroupsInRecord`, which is already the shipped query. The two rejected options and why are in
   `/tmp/opencode/plan07-slice1-questions.md`.

8. **Whether a link may name a character the glossary never published.** `cast_identity_links.a` and `.b` are
   `TEXT NOT NULL REFERENCES cast(key)` with `PRAGMA foreign_keys = ON`, so a connection can only join two names
   the record already publishes as characters. Measured on a copy of volume 17's record: **5 of the 18 groups
   §2.9 selects hold exactly one such name and therefore file nothing** — すみれこ (菫子 ×371 guided, 董子 on the
   roster), なでしこ (撫子 ×105, 赤井撫子), サンちやん (大賀太陽, plus 親友 / 大賀先輩 / 王子様 guided), ツバキ
   (selected **by the reading alone**), ミント (薄荷, 自分の彼氏). They are named in the door's own output
   (`guideUnlinkedGroups`), so the loss is on the record and re-measurable. The options: **(A)** leave them named
   — what is built; **(B)** let the door register a roster entry for a guided form it finds, which is the only
   option that actually links them, and costs changing what every later volume's coverage guard counts: the
   roster is the glossary's Characters table, and 菫子 or 椿 would become a name the guard asks a volume to cover
   when no glossary row and no published reference contains it; **(C)** relax the foreign keys, which means a new
   migration that weakens an existing table in a banned patch path and lets a link name a person the record does
   not publish — the exact thing these tables were built not to do; **(D)** add the forms to the glossary's
   Characters table through the door that has its own evidence rule, which changes 17 published files and every
   volume's roster. **Recommendation: keep A until the paid run has been done**, because B is a decision about
   what the roster means, not about this door.
   **Slice 3 (2026-10-15) put the same wall under a heavier load, and the number is worth having before this is
   decided.** A relation's parties are foreign keys to `cast_identities(identity)`, so the door can only key a
   name that already stands on an identity: measured on a copy of volume 17's record built up to §2.9's shape,
   **88 of the 196 roster entries are keyable and 108 are not**. 25 of those 108 were offered to the door as
   addressers, and all 25 were refused with 0 rows filed and 0 roster entries or identities invented. So option
   (A) is not only "5 of 18 groups file nothing" any more — it is "a reference about how the cast addresses
   people can describe roughly half the cast", and that is a bigger answer to give than the one this item was
   written with.
9. **Whether one annotation is evidence enough to link two names.** §2.9 works over *candidate groups*, and a
   candidate group needs two or more written forms under one reading, so a guide the author applies over **one**
   form is invisible to it. Measured: the old rule found 13 pairs, the new finds 15, 11 are shared, and the 2 the
   new rule loses are **リリス / 炭印嵐** (1 annotation, volume 7) and **アネモネ / 牡丹一華** (6 annotations,
   volume 8) — each one written form guided into another roster name. They are named in `guideSoloRosterPairs`
   and filed nowhere. The options: **(A)** report only — what is built; **(B)** file them, which means widening
   `GUIDE_GROUP_MIN_FORMS`, a rule of §2.2 whose guards already carry a measured false negative (しば ← 芝 ×416)
   the owner has decided to leave alone, and which makes a link out of a **single** annotation — the weakest
   evidence in this layer; **(C)** lower the minimum to 1, which explodes the candidate set from 97 groups to
   ~3,099 readings and forces §2.2 to be re-measured, not tweaked. **Recommendation: keep A.** If the two pairs
   are wanted, the honest route is B with the candidate-set question answered first, not a special case inside
   the door.
10. **The order the two doors have to run in, and who runs them (slice 3's report §5).** A relation's parties are
   foreign keys to `cast_identities`, so the relations door is **unreachable on a record whose identity door has not
   run** — which is every record in the corpus today (0 `cast_identities` rows in all 17). The honest order is
   identity first, relations second, and neither is wired into a stage. This is item 3's question again now carrying
   a dependency: answering it for the identity door silently answers it for the relations door. Slice 3's builder
   recommends **keeping item 8's option (A)** — the limit is named in the door's own output and re-measurable, while
   both ways past it re-open a defect this repository already paid for (gotcha 105, gotcha 117).
   **Slice 4 (2026-10-15) half-answered it, and the half it answered makes the dependency live.** The relations door
   now has a producer: the rebuild door files the acts of address this volume's chapter call reported, so the
   relations path runs on every volume of a real run while the identity door still does not. Measured on a copy of
   volume 17's record as it actually stands — 196 roster entries, **0 identities** — 4 planted acts produce
   **1 filed** (the narration act, which needs no person), **1 named limit** and **2 unlevelled**; so today the
   contract can describe **narration, withheld and unknown** and nothing else, and every act naming a cast member
   is refused with `relation-party-not-in-an-identity` and named in the report. **The decision this makes
   concrete:** wiring the identity door is no longer a question about a table nothing reaches — it is the
   difference between the acts of address a run already pays to read being filed and being thrown away. It is
   still the owner's, and it is still item 3's / item 8's.
11. **Who owns the rename list — the one rule in this layer that names a writing system.** Slice 5's view needs
   to know which guided forms are **renames** (a name the author changes by writing a reading over it — 三色院菫子
   → パンジー, 玄武 → ジヨーロ) rather than ordinary pronunciation guides, because a rename is the only case where
   "at most twice" is the wrong bound: 三色院菫子 is guided 18 times series-wide and 16 of them sit in volume 15.
   The obvious rule — *the reading is written in a different script from the form it sits on* — is the only one
   measured that reproduces §2.12's rename half (**202 (volume, form) pairs / 1,033 occurrences**), and it is a
   rule about **katakana**, which is why this slice did not put it in code: `test/test-no-language-axis-list.js`
   exists to keep a language out of the pipeline, and every other rule in this layer is script-neutral (the same
   view runs on a Cyrillic fixture). So the classification is **supplied by the caller** through
   `renameForms`, and `test/measure-annotated-view.js` derives it from each row's own `reading_script` and hands
   it in. The options: **(A)** what is built — the caller supplies the list, the door names no script, and a
   series in another writing system supplies its own; **(B)** put the script test in `view/select.js`, which is
   one function that names katakana inside a layer 453 files are scanned for never naming a language; **(C)**
   replace the bound itself — annotate every form guided every time regardless of count — which needs no rename
   list at all and costs the 1,440 (volume, form) pairs the bound refuses. **Recommendation: keep A**, and if the
   list should be derived rather than typed, derive it in the **measurement** and keep the door script-neutral;
   (C) is the option to reach for if the owner wants the view wired without ever maintaining a list.
