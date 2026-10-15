# Plan 07: written forms, relations, and a voice record that never looks forward

**Status: direction approved by the account owner 2026-10-15. Slice 0 is BUILT (2026-10-15)** — the
reader `utils/source/guide-groups.js`, its fixture suite `test/test-guide-groups.js` (94 checks), and
the re-measurement `test/measure-guide-groups.js` (0 model calls). **§2 below is that re-measurement,
and it corrects three numbers the plan was written with** (§2.2, §2.3, §2.7). Slices 1–7 are not built.

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

### 4.5 The annotated view, not the annotated archive

The model-facing view of a chapter re-emits HTML `<ruby>` for the §2.2 subset only — 192 rows series-wide,
not 45,429 occurrences. The stored bundle is unchanged. Markdown has no ruby syntax; pandoc's extension is
not standard; `<ruby>` is what the converter already parses on the way in, so the model needs no teaching.

### 4.6 Normalise before you compare, and teach the parsers first

- A quote is stripped of ruby markup before it is checked against the book, and the extraction prompt says
  to quote the word as printed without the reading.
- `parseVoiceMarkdown`, `parseGlossaryMarkdown` and the render round trips are taught to survive ruby
  markup **before** any published file is allowed to contain it. The order matters: a parser that meets
  markup it does not understand produces a corrupted claim body with no finding and no count that moves.

### 4.7 The glossary labels

One door writes the heading; three readers drop it by position. Rename it, re-render the 17 published
files from the record (0 model calls), and re-measure the render against what is on disk first — an
earlier comparison found volume 01 identical but volumes 02 and 17 losing rows the evidence rule had
refused, and that must be known before it happens, not discovered afterwards.

### 4.8 Notes in the source language

Built here; **paid for later**, on the owner's clean-run timing. Building it means two things at once:
the prompt asks for source-language notes, and the terminology-settlement agenda — which currently builds
its agenda by reading **English phrasing** in notes ("revealed later", "turns out to be", future tense) —
is re-taught, or it silently reports an empty agenda against a source-language glossary.

---

## 5. The slices, in build order

| # | Slice | Acceptance line |
|---|---|---|
| **0** | **BUILT 2026-10-15 — the corrected guide measurement.** `utils/source/guide-groups.js` reads a harvest and produces candidate groups; `test/test-guide-groups.js` (94 checks, fixtures only) pins the rule; `test/measure-guide-groups.js` re-runs every number in §2 over the live corpus with 0 model calls and writes nothing. | **Met, and three of the plan's own numbers moved.** §2.1–§2.3 are reproduced by a script that reads only the guide files, 0 model calls, and a test fails if the *rule* moves. The corrections: the "24 readings over more than one written form" is **14** (24 counted volume-and-form pairs), the パンジー group spans **10** volumes not 12, and 三色院菫子 → パンジー is **18 occurrences series-wide, 16 of them in volume 15**. Plan 06 §2.11's retired conclusion is named as retired, not deleted. |
| **1** | **Written forms become recorded facts.** A door files each candidate guided form — form, reading, script, volumes, chapters, count — into the record. | Measured on copies of all 17 records: the filed set matches the **§2.2 candidate set** (97 groups / 222 forms / 634 rows), not the display subset. Every already-filed form is recognised on a second pass and files 0 new rows. No published artifact changes. No stage calls it yet. |
| **2** | **Identities carry the forms, with the widened rule.** Two forms guided to the same reading join one identity, **for the groups §2.9's roster test selects** — 18 of the 97 — and the rest are recorded as candidates or not at all, which is the decision §6.5 asks. Statements only — no claim ever moves. | On a copy of volume 17's record: パンジー's group contains the forms in §2.3, and the group is reachable from a query. `cast_merges` stays 0. A planted claim stays under the form that filed it. **The rule must not require one form to be unknown** — §2.9 shows that half throws away さんしよくいんすみれこ and つきみ, which are real links between two roster names. |
| **3** | **The relations table.** Schema 12, the columns in §4.3, the two non-negotiable rules, and a door that files a relation and closes a span *with its reason*. | A planted development closes an earlier span in the later volume's copy and leaves the earlier volume's snapshot byte-identical. A span closed without a reason is refused. A row's content columns never change after filing — asserted column by column. |
| **4** | **The extraction contract.** A relation is a kind in the chapter call that already runs — no extra call — with the §4.4 certainty ladder and `withheld` / `narration` as legal answers. | Pass 1 files relations, pass 2 over the same fixture pays 0 calls. A planted "the name in the quote is the addressee" case comes back `addressee-risk`, not `measured`. A chapter that names nobody files nothing and is named, not punished. |
| **5** | **Normalise, teach, then show.** Ruby stripping before quote comparison; the markdown parsers taught; only then the annotated view. | The wrong order is proven to be the wrong order: a test shows a parser meeting un-taught markup glues a line onto a published claim's body, and shows the taught parser not doing so. The annotated view adds the §2.2 subset and nothing else. |
| **6** | **The glossary labels, and a render-only door.** Rename the heading, add the door that re-renders a published glossary from its record with 0 model calls, and re-render the 17 files. | The render is compared against what is on disk **before** anything is replaced, and every row that disappears is named with the rule that refused it. No sealed row is edited. The freeze gate is not asked to excuse anything. |
| **7** | **Source-language notes, and the re-taught agenda.** Built and pinned; not run for real. | A fixture glossary renders with source-language notes. The settlement agenda still finds its candidates against source-language notes — measured, not assumed. The paid run is explicitly not taken. |

**Slice 0 is first because everything else reads its numbers.** Slice 5 is deliberately after 3 and 4 so
the parsers are taught before any file can contain the markup. Slice 6 is the only slice that touches
published files, and it is placed late so the measurement in §4.7 is done with the rest of the plan settled.

---

## 6. Open decisions, for the account owner

1. **The exact wording of the two glossary headings.** The plan uses *Source* and *Target*. Cosmetic,
   reversible, one line — but it lands in 17 published files, so it should be said once.
2. **Which certainty levels may trigger an investigation.** `addressee-risk` is the interesting one and it
   fires often; the run-wide investigation bound is 3, and one real investigation turn measured 7.2M tokens
   and 12 minutes. A bounded read-only reading pass measured 1 call and 10,530 tokens for a whole volume.
   The threshold is a decision about how much you want to pay to know who is speaking.
3. **Whether `withheld` relations reach the translator.** They are a fact with instruction attached —
   *keep this unresolved* — but they live in a record the translator reads, and printing them is a
   decision about what the translator is told.
4. **Whether the identity door runs per volume or once per series.** Plan 06 §10.9 asked this and left it.
   This plan's recommendation: once per series, as the glossary step's last act, beside the terminology
   settlement — a query, no model calls, its own records, not declared artifacts.
5. **How far the annotated view goes.** The §2.2 display subset is 192 rows. Whether ordinary hiragana
   guides on rare kanji are also worth showing is a judgement about the model's reading, not a
   measurement, and it changes the size of every chapter prompt. (The candidate set is 634 rows / 8,734
   occurrences, so the display filter is what keeps the view small — that is the whole reason it exists.)
6. **Whether a group whose forms are all descriptions or first-person pronouns is an identity link at
   all.** おれ (← 俺 x3,820 / 脇役), あなた (← 貴方 x535 / 貴女 x278), あなたたち, あなたさま, わたし
   (← 自分 / 他人 / 菫) and モブ (← 脇役 / 主人公) are 4,700 occurrences the roster test cannot see, and
   the guide is plainly *doing something* in them — the author guides 脇役 ("supporting role") with the
   same reading as 俺 ("I"). Filing them as identities, filing them as written forms with no identity,
   or leaving them out is a decision about what the record asserts, and §2.9 cannot answer it.
7. **How wide the roster match has to be.** ジヨーロ is one edit from the roster's ジョーロ, and its form
   如雨露 is a truncation of 如月雨露; チエリー / チェリー and サンちやん / サンちゃん are the same shape.
   An exact-match test misses all three. The store's name-matching rule is deliberately narrow (gotcha
   121 refused to widen it from one scene's evidence), and widening it changes how every later volume
   measures every character — which is the owner's call, not a slice's.
8. **What happens to the 79 groups no rule selects.** 500 harvest rows and 7,332 occurrences of homophone
   pairs and orthographic variants (太股 / 太腿, 偽物 / 偽者, 潑溂 / 潑剌, 我侭 / 我儘, 呆然 / 茫然). Some are
   the *same word written two ways*, which a written-form layer arguably should know even when no person
   is involved. Filing them, or naming them in a report and filing nothing, is a decision about how big
   the written-form table gets.
