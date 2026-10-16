# Plan 09 — the extraction keeps every reading aid in the text

Plan of record. Written 2026-10-16. Status: **slice 0 BUILT 2026-10-16** (the converter, both paths, and the
bundle schema 8 → 9); **slices 1–6 not built**. Slice 0's own measurement is §2.5, and it corrected two figures
this plan published in §2.2 — the corrections are in §2.2 itself, not buried here.

This plan **supersedes plan 08 slice 0** (the per-chapter reading table, built 2026-10-16 and committed as
`9116904`) and **absorbs plan 08 slices 1–4**, which are re-numbered here. Plan 08 stays as the record of why
the table was built and what it measured; where it and this plan disagree, this plan wins.

---

## 0. The decisions this plan is built on

**Decision 1 (the account owner, 2026-10-16) — the extraction keeps every reading aid, in the text.**
The epub → markdown converter currently takes the pronunciation guides *out* of the words and writes them to a
side file. That is replaced: **every reading aid the book prints stays in the extracted chapter**, because
whether an annotation carries meaning is not knowable at extraction time. An annotation may carry no meaning;
it may carry meaning only because of what happens three volumes later; and discarding it is the one act that
cannot be undone. "We cannot tell, therefore we keep" is the rule.

**Decision 2 (the account owner, 2026-10-16) — the form is ruby markup with the word kept whole.**
`<ruby>蒲田<rt>かまた</rt></ruby>`, one element per annotated word, the base characters contiguous. The
faithful shape (the book's own per-piece markup, `<ruby>蒲<rt>かま</rt>田<rt>た</rt></ruby>`) was measured and
**rejected**: it puts tags *inside* the word in 21,445 occurrences, which is the same family of damage as
gotcha 123 and breaks any plain search for the word. The compact bracket form (`蒲田[かまた]`) was measured and
**rejected**: it makes the reading part of the term string for every door that reads a term out of the text.

**Decision 3 (the account owner, 2026-10-16) — the display table goes away.**
Plan 08 slice 0's per-chapter table exists only because the text did not hold the readings. Once it does, the
table is deleted, not kept alongside. **The harvest file stays**: it is the machine-readable record of every
guide, and "the reading changed in a later volume" is a query over rows, which no chapter text can answer.

**Decision 4 (the account owner, 2026-10-16) — the published glossary gains the reading as a column.**

**Decision 5 (the account owner, 2026-10-16) — a wording that contradicts a printed reading is filed and named,
never refused.** The term is not thrown away; the disagreement is printed where the grader reads it and
recorded where the terminology review can act on it.

**Carried forward unchanged:** no closed status vocabulary; nothing names a language; a published row is never
edited, only superseded; damage to a published reference is a hard stop; no real model spend until
pre-production is finished.

---

## 1. The problem, in one paragraph

The converter was fixed in October to stop pasting a guide into the word it annotates (gotcha 123), and the fix
removed the guide. The word became clean and the annotation became a side file no stage reads. Plan 08 slice 0
papered over that by handing the glossary's model a table beside the chapter. That was a workaround for a
missing fact in the artifact, and it cost 12.88 % of the chapter text to deliver a copy of information the book
had already put in the right place. The right fix is in the converter.

---

## 2. The measurements

All 0 model calls, 0 database opens, nothing written into `SERIES_LOCATION`.
Scripts: `/tmp/opencode/measure-inline-reading-aids.js`, `/tmp/opencode/measure-reading-shift.js`,
`/tmp/opencode/measure-reading-table-cost.js`.

### 2.1 What is there to keep

17 volumes, 133 chapters, **2,450,316 characters** of extracted text today.
**45,429 guided occurrences**, **10,005** word-and-reading rows, **3,645** distinct written forms.
The reading text itself is **146,216 characters — 5.97 %** of the books, and it is currently **not in the books
at all**.
**5,602 written forms (21,445 occurrences) are annotated piece by piece** in the source — these are the ones the
faithful markup would split across tags.

### 2.2 What keeping them costs, priced three ways

| Form written into the chapter file | Added characters | Share of the books | Biggest chapter becomes |
|---|---|---|---|
| **`<ruby>base<rt>reading</rt></ruby>`, base contiguous (chosen)** | **+1,145,628** (measured) | **46.75 %** | **66,502** (measured) |
| `base[reading]` | +237,074 (projected) | 9.68 % | 50,188 (projected) |
| the book's own per-piece markup | +1,338,659 (projected) | 54.63 % | 59,898 (projected) |

Per chapter under the chosen form, **measured on the 17 real books by slice 0 (§2.5)**: **median 27,582
characters (today 20,605), p90 47,423, max 66,502**. Against the translation stage's measured part ceiling of
**80,332 characters**, **0 chapters** require splitting — the admission limit is not what this change breaks.

**Two figures this plan published were wrong, and how they were wrong is the lesson.** Slice 0 ran the real
converter over all 17 archives and compared, and the differences are not noise:

- **The total (+1,145,654) was 26 characters too high.** It priced a tag set for **all 45,429** guided
  occurrences and counted all 146,216 characters of reading as newly added. The converter writes markup for
  **45,428** of them: one annotation in the corpus is a **reading with no word under it**, and a reading with no
  word is plain text today and plain text after — it gains no tags and its 4 characters were already in the
  file. The measured growth is **45,428 × 22 characters of tags + 146,212 characters of reading = 1,145,628**,
  which is arithmetic rather than an estimate.
- **The per-chapter figures (median 27,950 / p90 45,772 / max 59,898) were an estimate that cannot be right per
  chapter.** `measure-inline-reading-aids.js` priced a chapter by **spreading each word-and-reading pair's
  volume-wide count evenly over the chapters that pair appears in** (`count / chapters`), because the extracted
  text records no guide positions (gotcha 171). That is exact in **total** — which is why the total reproduced —
  and wrong for any single chapter, because a guide is not evenly distributed: 三色院菫子 → パンジー is 16 of its
  18 occurrences in one book, and an arc chapter annotates names while a bridge chapter does not. The measured
  max is **66,502**, not 59,898: **6,604 characters, 11 %, on the one chapter the ceiling question is actually
  about.** The conclusion survives (0 chapters over 80,332) but the margin it was reported with did not.

**The rule this writes into the plan: a per-item figure derived from a per-volume total is a projection, and it
must be labelled as one.** The total was a measurement; the distribution was arithmetic on an assumption of
evenness; and the row that mattered for the admission ceiling was the one built on the assumption.

For comparison, plan 08 slice 0's table cost **+315,646 (12.88 %)** on the chapter-by-chapter route and bought
a *copy* of the same information. The chosen form costs more and puts it where the book put it.

**Tokens, and what is not measured here.** Estimated source tokens over the 133 chapters move
**1,699,603 → 2,102,950 (+23.7 %)** — well below the +46.75 % character growth, because the tags are ASCII
(priced 0.25 tokens per character by the repo's own coefficients) and the readings are not (0.69). Per chapter
the estimated maximum moves **33,201 → 37,537**. **That is an estimate, not a measurement**: it assumes markup
punctuation tokenizes like ordinary ASCII, which a tag run like `<ruby>…<rt>…</rt></ruby>` may not. A real
number needs a calibration probe against the endpoint, which is a model call, and no call was made here.

### 2.3 What already exists for this

`utils/reference-store/ruby-markup.js` (198 lines) is the store's one rule about HTML ruby — strip, build,
count — and plan 07 slice 5 put the strip inside `normalizeQuote` / `quoteSkeleton`, so **every citation door
in this repository already compares guide-free text**. `parseVoiceMarkdown` and `parseGlossaryMarkdown` were
taught the markup *before* any published file was allowed to carry it, and both currently report an empty
annotated list for every document this repository has ever published — because no document has ever carried it.
`RUBY_GUIDE_TAGS` is one constant shared by the converter and the store's tag list, pinned equal by a test.

**This plan is the reason that work exists.** It has been waiting for text that actually contains the markup.

### 2.4 The hazard this closes, and the one it opens

**Closes.** Gotcha 123 left an unpaid bill: when the converter stopped printing the split text, the reference
records already published quoted the *old* string, and replaying the evidence audit over copies of the two real
records raised **16 HIGH findings on volume 1 and 31 on volume 2** — the claims were true, only the string the
book prints had changed. That decision was never taken. With the guides back in the text and the strip rule on
the search side, a guide-free quote a published record holds still matches the book, and the bill is paid
without re-deriving anything.

**Opens.** A base is contiguous *inside one annotated word*, not across two. If the book annotates 三色院 and
菫子 separately, the text reads `<ruby>三色院<rt>…</rt></ruby><ruby>菫子<rt>…</rt></ruby>` and a plain search
for 三色院菫子 **fails**. Every door that searches chapter text — the evidence rule, the quote doors, the cast
presence match, the chapter-facts query that decides what a chapter is shown — must search the **guide-free
projection**, not the raw file. That is slice 1, and it is the load-bearing slice of this plan: without it the
change silently stops finding characters in chapters that annotate them piece by piece.

> **Corrected by slice 0, 2026-10-16.** This paragraph was written before the code was asked. It is **half
> wrong**: none of those four doors searches the raw file. `prepareLineForQuoteSearch` / `matchQuoteOnLine`
> strip the **line** as well as the quote, `presence.js` and `chapter-facts.js` both call them, and
> `glossaryTermSpans` strips before it splits — plan 07 slice 5 put the strip in that one normaliser, and it
> covers all four. Measured against a chapter the new converter wrote: 蒲田 annotated piece by piece **found**,
> 三色院菫子 across two elements **found**, a markup-bearing quote whose guide-free content is not in the book
> **refused**. What the hazard *did* survive into is a different rung — the **skeleton** match accepts a reading
> spliced into the word. Both halves are written out in §5's slice-0 note, and that note, not this paragraph,
> is what slice 1 should be built against.

---

### 2.5 What slice 0 measured, on the real books (2026-10-16)

`/tmp/opencode/plan09-measure-all-volumes.js` runs the **shipped converter** over all 17 archives in a scratch
copy of each volume folder, and writes **nothing inside `SERIES_LOCATION`**: 0 model calls, 0 database opens, 0
corpus writes. The 17 `series.db` digests and the 34 `-wal` / `-shm` sidecars were taken before and after the
whole slice and are **identical** (`/tmp/opencode/plan09-slice0-corpus-before.tsv` →
`…-corpus-final.tsv`).

| Question | Answer |
|---|---|
| Text on disk → text the new converter writes | **2,450,316 → 3,595,944 characters (+1,145,628, +46.75 %)** |
| Annotations that become markup | **45,428 of 45,429** — 45,428 base+reading, **0** base-with-no-reading, **1** reading-with-no-base (plain text, no tags), 0 empty |
| **The load-bearing proof** | **133 of 133 chapters: `stripRubyMarkup(newText)` is byte-identical to the chapter file on disk.** The guide-free search surface does not move one character, so every quote a published record already holds still matches the book — gotcha 123's unpaid bill (16 HIGH on volume 1, 31 on volume 2) is paid without re-deriving anything |
| The harvest | **Identical for all 17 volumes**: 10,005 rows, 45,429 occurrences, every `annotated` sequence, every `annotatedVariants`, every total. The harvest is built by `splitRuby`, not by the renderer, and this is the number that proves it |
| The packaging decision (`classifySectionGroup`) | Moves for **0** volumes; every volume's `storyTextChars` is identical, because `textCharsOf` measures the guide-free projection |
| The 200-character "converted to nothing" floor | **0** chapters cross it in either direction |
| The 80,332-character part ceiling | **0** chapters over it. Biggest chapter **47,930 → 66,502** |
| The guide-split tripwire | **0** hits across all 17 books, and it still fires on a planted split string (pinned in `test/test-source-ruby-markup.js` scenario 9) |
| Volume 08, the most annotated book | **152,951 → 309,978 characters (+102.66 %)**, 6,256 ruby units, 0 split hits, harvest byte-identical |

**What the slice chose, and where it disagreed with the plan's own wording.** Chapter **headings and chapter
titles stay guide-free**: `firstHeadingText`, the nav reader and `stripRepeatedHeading` all compare a heading
against the name the contents list carries, and that name has no markup in it, so a heading carrying markup
matches nothing and the duplicate-heading rule silently stops working. `titleOfUnnamedSection` therefore
**measures and returns the guide-free line** — the name a chapter is filed under is a name, not a name plus its
guides. The prose under them carries the markup. That split is not in §4.1's wording, and it is the one place
where the plan's "every reading aid stays in the extracted chapter" is narrower in practice than it reads.

**And one thing the slice refused to do:** `utils/source/` does not `require` the reference store's
`ruby-markup.js`. A converter that needs a module sitting behind every evidence query in the repository is a
layer inversion (and `ruby-markup.js`'s own test pins that it requires nothing but `../../types`). The strip
rule is therefore **restated** in `utils/source/html.js` as `guideFreeTextOf` over `RUBY_TAG_PATTERN_SOURCE`,
and the two copies are pinned **equal by a test** — the pattern source string and the tag list compared
directly, and 16 markup shapes run through both. `ruby-markup.js` now **exports** `RUBY_TAG_PATTERN_SOURCE` for
exactly that reason.

---

## 3. What this replaces, and what it leaves alone

| Stays | Changes |
|---|---|
| The harvest file `<base>-ruby-guides.json`, and `written_forms` filing from it | The extracted chapter carries the guides as markup, so the harvest is the record and the text is the display |
| `stripRubyMarkup` as the store's one ruby rule | It becomes the rule **every text-searching door uses**, not only the citation doors |
| The `guide-split-in-text` tripwire (HIGH) | It stays, and gets a companion: a canonical-shape check and a count check on the markup the converter wrote |
| Plan 08 slice 0's reading table | **Deleted**, with its suite, its 13 barrel exports and its two call sites |
| `BUNDLE_SCHEMA_VERSION` 8 | **9**, because the converter's behaviour is not part of the bundle cache key (gotcha 123) and leaving it serves guide-free text forever |
| The glossary's answer shape (`{"terms": […], "revisions": […]}`, closed) | The prompt teaches the markup: the term is the word **without** the tags |

---

## 4. The design

### 4.1 Canonical ruby

One element per annotated word: `<ruby>${base}<rt>${reading}</rt></ruby>`, where `base` is the word with its
guides taken out and `reading` is every guide that sat on it, in document order. The word is contiguous. The
split string the old converter produced cannot appear, because it is never written.

- A guide with **no base** emits the reading as plain text, as it does today — an empty `<ruby>` is not markup,
  it is a shape error.
- Both converters move together: the one the stages read (`utils/source/html.js`'s cheerio path) and the one the
  intake measures books by (its `inlineTextOf` path). They already share `RUBY_GUIDE_TAGS` for exactly this
  reason; a change to one and not the other is gotcha 119's shape.
- The harvest is written from the same pass and its rows must come out **identical** to what they are today.
  The harvest is the record; the markup is the display. If the harvest moves, something else broke.

### 4.2 The guide-free projection

Every door that searches chapter text searches the stripped projection. One rule, one place, already built.
A quote that only exists *with* the markup inside it is refused — that is a forgery, not a match.

> **Half true, half not, measured by slice 0 (2026-10-16).** The first sentence is true and the four doors
> §2.4 named already use it. The second is **not** what the code does: a markup-bearing quote is refused only
> when its **guide-free content** is absent, and the quote `彼は蒲田かまたを見た。` — the reading spliced into
> the word, the guide-split shape — **matches** through the skeleton rung, because that rung drops kana on both
> sides. Probing this is what found it; the details and the three ways out are in §5's slice-0 note and in
> `/tmp/opencode/plan09-slice0-questions.md` question 4.

### 4.3 The corpus act is separate — **and that sentence is wrong about the code**

Re-extracting 17 volumes rewrites 133 chapter files and 17 whole-volume files and grows them 46.75 %
(measured, §2.5). It is
**not** part of any build slice. It is the account owner's, it is asked for explicitly, and it is measured
before and after against the pinned record digests (gotcha 124, gotcha 172).

> **Corrected by slice 0, 2026-10-16: it is not asked for explicitly, and it cannot be.** Moving
> `BUNDLE_SCHEMA_VERSION` to 9 is what makes a schema-8 cache refused, and **twelve production callers** resolve
> their book through that one door — the nine book-reading stages, `extract-voice`, a progress helper and the
> `extract` step (counted by a grep of the tree). So the next `npx gulp glossary`, `npm run pipeline` or
> `npm start` rewrites all 17 books without being asked to. The paragraph above describes the act the owner
> should *take*, not the behaviour the code has. The three ways out — accept it and time it; undo the bump,
> which is gotcha 123's bug chosen again; or make a stale cache a refusal instead of a silent re-extraction —
> are written up with their costs in `/tmp/opencode/plan09-slice0-questions.md` question 1. **Slice 0 picked
> none of them, and changed no code to force one.**

---

## 5. The slices, in build order

| # | Slice | Acceptance line |
|---|---|---|
| **0** | **The converter keeps the guides, canonically, and the bundle schema moves.** Both converter paths, one shape. **BUILT 2026-10-16 — every clause met, measured in §2.5.** Two figures this plan carried into §2.2 were corrected by the build, and one wording choice (§4.1's "every reading aid") is narrower in practice than it reads: headings and titles stay guide-free. | A fixture whose source annotates a word piece by piece extracts as `<ruby>蒲田<rt>かまた</rt></ruby>` with the base contiguous; the split string appears **0** times; the harvest rows and counts are **identical** to what the same fixture produced before the change; `BUNDLE_SCHEMA_VERSION` **8 → 9** and a cached bundle under 8 is refused rather than reused; a guide with no base emits plain text; the six extraction audits run over markup-bearing text and the split tripwire still reports 0 on legitimate fixtures. **0 model calls, 0 corpus writes.** |
| **1** | **Every door that searches chapter text searches the guide-free projection.** | On a fixture chapter carrying canonical ruby: a name the book annotates as a whole is found; a name the book annotates **piece by piece across two elements** is found; a phrase spanning two annotated words is found; a planted quote that only exists with the markup inside it is **refused**; `cast_presence_match` and the chapter-facts query report the same characters with and without the markup. The extraction audit gains a canonical-shape check and a markup-count check. **0 model calls.** |
| **2** | **The glossary read pass reads the hints from the text, and the table is deleted.** | `glossary/extract/reading-block.js`, its suite, its 13 barrel exports and its two call sites are **gone**; `system-prompts/glossary-terms.md` names the markup and says the term is the word without the tags; the offline loops' `glossary-extract` prompt returns to its pre-table size on plain-text fixtures; **0 new model calls**, both loop baselines unmoved. |
| **3** | **The reading is recorded beside the term, and the published glossary gains its column.** | A new **insert-only** row kind at `SCHEMA_VERSION` **14**; filing a term the book guided records every reading that volume guided for that form; a term the book never guided records nothing and says so; a second pass files 0; every content column of the published term row compared and **unmoved**; `GLOSSARY_HEADER` gains the fourth column and all three readers still drop the header by position; the re-render door's comparison still refuses a lost row, a moved cell and an empty render, measured over **copies** of all 17 records; a wording that contradicts a printed reading is **filed and named** in the report the grader reads. |
| **4** | **"The reading changed" becomes the forward half of the terminology review.** | A query over the recorded readings replaces `FORWARD_REVEAL_SHAPES`; on copies of the 17 records, 0 model calls, it finds the measured **266 / 129** classes and ranks them inside the existing 24-call bound; a fixture where a later volume guides a form differently puts that term on the agenda with **no phrase matching at all**; the phrase path stays for records that predate the column and the coverage report names which half produced the agenda. |
| **5** | **The revision door stops assuming newer is better** for a change in how a name is spoken. | A planted revision that contradicts a reading the book prints **repeatedly** is **named, not settled**; a planted genuine correction still settles; both outcomes print the guide and the choice side by side; 0 published rows edited. |
| **6** | **A published translation never carries the markup.** | The translator is still shown the annotated source; the translation, verify, retranslate and polish outputs are checked for ruby tags and a stray tag is a finding; the paragraph-alignment check is unmoved; the published artifacts of the offline loops contain **0** tags. |

Slice 1 is the one that decides whether this plan is safe. Slice 2 is the one that pays for slice 0 by removing
the workaround. Slices 3–5 are plan 08's slices 1–3, re-numbered, and they are what make "the reading changed"
answerable without a phrase list.

**What slice 0 did NOT do, so nobody reads the row as done.** The **canonical-shape check** and the
**markup-count check** named in §3 and in slice 1's line are **not built** — slice 0's acceptance line did not
ask for them, and adding a check to the extraction audit is slice 1's job, not a side effect of the converter
change.

**And §2.4's "Opens" half is already closed, which the probe proved and the plan did not know.** Slice 0 ran
the store's own matching rule against a chapter the new converter had just written
(`/tmp/opencode/plan09-probe-search-doors.js`, fixtures, 0 model calls, 0 database opens):

| Asked of the annotated chapter | Answer |
|---|---|
| 蒲田 — a name the book annotated **piece by piece** | **found**, `verbatim` |
| 三色院菫子 — a phrase spanning **two separately annotated words** | **found**, `verbatim` |
| The whole annotated sentence, guide-free | **found**, `verbatim` |
| A quote carrying markup whose guide-free content **is** in the book | **found**, `verbatim`, and reported as `markupStripped: true` |
| A quote carrying markup whose guide-free content is **not** in the book | **refused** — already pinned by `test/test-annotated-view.js` scenario 8 ("stripping is not a licence") |

The reason is that §2.4 named four doors and every one of them already goes through **one** normaliser:
`prepareLineForQuoteSearch` / `matchQuoteOnLine` in `utils/reference-store/evidence.js` strip the **line** as
well as the quote, `presence.js` and `chapter-facts.js` both call them, and `glossaryTermSpans` strips before
it splits. Plan 07 slice 5 put the strip there; this plan is the reason it was put there, and it turned out to
be enough. **Slice 1 is therefore smaller than its row reads**: its searching-door half is a **verification**
task, not a build task.

**What slice 1 does have to build, and it is not small.** The probe found one shape §4.2 asserts and the code
does not do. The quote `彼は蒲田かまたを見た。` — **the reading spliced into the word**, which is the
guide-split shape this whole plan exists to prevent — **matches**, through the skeleton rung: its Han-only
skeleton `彼蒲田見` is a substring of the line's skeleton `彼蒲田見三色院菫子見`. The strip cannot help, because
the reading is kana and the skeleton drops kana on **both** sides. **This is not damage slice 0 caused** — the
guide-free line is byte-identical to the one on disk, so the same forgery passes today, and it has passed since
the skeleton rule was written. But it means the sentence "a planted quote that only exists with the markup
inside it is **refused**" is a rule slice 1 has to build against a rung that exists on purpose (it is what lets
`双ふた花ばの恋物語` match `双ふた花こい物もの語がたり`), in a **banned patch path**
(`utils/reference-store/evidence.js`). Narrowing it without breaking that pair is slice 1's actual problem, and
it is a decision about an existing guard, not an addition.

---

## 6. Open decisions, for the account owner

1. **When the corpus is re-extracted.** Nothing in this plan is observable on the real books until it is. It
   grows 133 chapter files and 17 whole-volume files by 46.75 % (measured, §2.2), re-runs the six extraction audits, and moves
   every pinned character-count figure in the docs. The reference records themselves are not touched.
2. **Whether the other stages' prompts are taught the markup** in this plan or left to read it cold. The wiki,
   the style guide and the character-voice pass all read the same chapter files and will see the tags whether
   they are told about them or not.
3. **Whether the fourth glossary column also reaches the series-root `glossary.md`** (284,687 bytes, the
   settlement pass's render, which still prints the old headings).
4. **Whether the translation stage is shown the markup at all.** Decision 2 chose the form written into the
   files; showing it to the call that produces the published translation is a separate question, and slice 6
   only guards the output.
5. **Whether the guide-split tripwire is still worth a HIGH finding** once the split string can no longer be
   produced by the converter, or whether it becomes the guard against a *hand-edited* chapter file.

---

## 7. What this must not become

- **Not a second copy of the same information.** The table is deleted, not kept beside the text. Two copies of
  one fact is two things that can disagree.
- **Not a licence to search raw text.** The guide-free projection is the search surface. A door that searches
  the raw file is a door that silently stops finding annotated names.
- **Not a markup the model is asked to reproduce.** The reading is something the model *reads*. Only the
  glossary's own column and the run's records carry it forward; a published translation carrying tags is a
  defect, and slice 6 makes it one.
- **Not a corpus write.** No slice in this plan re-extracts a real volume.
