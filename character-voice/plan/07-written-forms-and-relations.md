# Plan 07: written forms, relations, and a voice record that never looks forward

**Status: PLAN — direction approved by the account owner 2026-10-15. Nothing built yet.**

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

### 2.2 The meaningful subset is small

Most guides are ordinary pronunciation help: a kanji word with its normal reading. The subset where the
author is doing something *with* the word — a kanji word given a **katakana** reading — is:

| | |
|---|---|
| rows, series-wide | **192** |
| distinct readings | **99** |

Occurrences are mostly 1–4. This is the set worth showing a model, and the set worth recording as facts.

### 2.3 The finding that changes the design

Asked which of those 99 readings the author prints over **more than one written form**, 24 of them do:

| Reading | Written forms the author used for it |
|---|---|
| **パンジー** | 朱雀, 虎, 好きな女, その綺麗な女性, お姫様, 友達, 三色菫, 三色院菫子, 虹彩寺菫, 菫, 主人公, 恋人 — across 12 volumes; 311 occurrences of 虹彩寺菫 in volume 15 alone |
| **コスモス** | 青龍, 生徒会長, 秋桜, 秋野桜, 怪物 |
| **サンちやん** | 王子様, 大賀先輩, 親友, 大賀太陽 |
| **イラストレーター** | 世界の支配者, in 7 different volumes |
| **ブリキ** | 神, in 7 volumes |
| **チエリー** | 桜桃, 面倒事, 桜原桃, 元生徒会長 |
| **ホース** | 好きな男, 主人公, 葉月保雄 |
| **ジヨーロ** | 玄武, 親友, 如雨露, 主人公 |
| **ビオラ** | 菫, 誠実, 好きな人, 虹彩寺菫 |
| **ガーベラ** | 大千本槍, in 4 volumes |
| **サザンカ** | 山茶花, in 3 volumes |

**The author writes a description and guides it with a name.** 好きな女 — "the girl I like" — read
パンジー. 主人公 — "the protagonist" — read サンちやん. 世界の支配者 — "the ruler of the world" — read
イラストレーター. Identity is hidden behind a description and the reading is the tell.

Three consequences, each load-bearing:

- **No name-matching rule can ever find these links.** "The protagonist" and 大賀太陽 being the same
  person is not discoverable from strings. It is discoverable from the guide.
- **虹彩寺菫 → パンジー 311 times and 三色院菫子 → パンジー 16 times, in the same volume.** A name changes
  *within* one book. That is a relation with a date, which is exactly what `valid_from` / `valid_to` is for.
- **サンちやん vs サンちゃん** — the two roster entries one character apart, open since plan 06 — is
  settled by the guide, which prints the first form over four written forms.

### 2.4 A correction to plan 06, stated because a later slice must not reuse the old number

Plan 06 §2.3 measured the guide file as stating **13 name links across 24 roster entries** and concluded
it was a weak source. **That measurement asked the wrong question.** It looked for pairs where *both* sides
were already roster names. The valuable shape is *any written form guided to the same reading*, which
includes descriptions that are not names at all. Measured correctly: 192 rows, 99 readings, 24 readings
spanning multiple written forms. Plan 06's conclusion — "no source states most of these links in a form a
door can file" — is **retired**.

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

---

## 3. What this replaces, and what it leaves alone

**Replaced or retired**
- Plan 06 §2.3's roster-link measurement and its conclusion (§2.4).
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
| **0** | **The corrected guide measurement.** Re-run the guide analysis properly over all 17 volumes, pin the numbers in a test, and retire plan 06 §2.3's 13-pair measurement in the docs. | The numbers in §2.1–§2.3 are reproduced by a script that reads only the guide files, 0 model calls, and a test fails if they move. Plan 06's retired conclusion is named as retired, not deleted. |
| **1** | **Written forms become recorded facts.** A door files each meaningful guided form — form, reading, script, volumes, chapters, count — into the record. | Measured on copies of all 17 records: the filed set matches the §2.2 numbers. Every already-filed form is recognised on a second pass and files 0 new rows. No published artifact changes. No stage calls it yet. |
| **2** | **Identities carry the forms, with the widened rule.** Two forms guided to the same reading join one identity. Statements only — no claim ever moves. | On a copy of volume 17's record: パンジー's group contains the forms in §2.3, and the group is reachable from a query. `cast_merges` stays 0. A planted claim stays under the form that filed it. |
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
5. **How far the annotated view goes.** The §2.2 subset is 192 rows. Whether ordinary hiragana guides on
   rare kanji are also worth showing is a judgement about the model's reading, not a measurement, and it
   changes the size of every chapter prompt.
