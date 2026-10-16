# Plan 09 — the extraction keeps every reading aid in the text

Plan of record. Written 2026-10-16. Status: **nothing built yet.**

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
| **`<ruby>base<rt>reading</rt></ruby>`, base contiguous (chosen)** | **+1,145,654** | **46.76 %** | 59,898 |
| `base[reading]` | +237,074 | 9.68 % | 50,188 |
| the book's own per-piece markup | +1,338,659 | 54.63 % | 59,898 |

Per chapter under the chosen form: **median 27,950 characters (today 20,605), p90 45,772, max 59,898**.
Against the translation stage's measured part ceiling of **80,332 characters**, **0 chapters** would newly
require splitting — the admission limit is not what this change breaks.

For comparison, plan 08 slice 0's table cost **+315,646 (12.88 %)** on the chapter-by-chapter route and bought
a *copy* of the same information. The chosen form costs more and puts it where the book put it.

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

### 4.3 The corpus act is separate

Re-extracting 17 volumes rewrites 133 chapter files and 17 whole-volume files and grows them 46.76 %. It is
**not** part of any build slice. It is the account owner's, it is asked for explicitly, and it is measured
before and after against the pinned record digests (gotcha 124, gotcha 172).

---

## 5. The slices, in build order

| # | Slice | Acceptance line |
|---|---|---|
| **0** | **The converter keeps the guides, canonically, and the bundle schema moves.** Both converter paths, one shape. | A fixture whose source annotates a word piece by piece extracts as `<ruby>蒲田<rt>かまた</rt></ruby>` with the base contiguous; the split string appears **0** times; the harvest rows and counts are **identical** to what the same fixture produced before the change; `BUNDLE_SCHEMA_VERSION` **8 → 9** and a cached bundle under 8 is refused rather than reused; a guide with no base emits plain text; the six extraction audits run over markup-bearing text and the split tripwire still reports 0 on legitimate fixtures. **0 model calls, 0 corpus writes.** |
| **1** | **Every door that searches chapter text searches the guide-free projection.** | On a fixture chapter carrying canonical ruby: a name the book annotates as a whole is found; a name the book annotates **piece by piece across two elements** is found; a phrase spanning two annotated words is found; a planted quote that only exists with the markup inside it is **refused**; `cast_presence_match` and the chapter-facts query report the same characters with and without the markup. The extraction audit gains a canonical-shape check and a markup-count check. **0 model calls.** |
| **2** | **The glossary read pass reads the hints from the text, and the table is deleted.** | `glossary/extract/reading-block.js`, its suite, its 13 barrel exports and its two call sites are **gone**; `system-prompts/glossary-terms.md` names the markup and says the term is the word without the tags; the offline loops' `glossary-extract` prompt returns to its pre-table size on plain-text fixtures; **0 new model calls**, both loop baselines unmoved. |
| **3** | **The reading is recorded beside the term, and the published glossary gains its column.** | A new **insert-only** row kind at `SCHEMA_VERSION` **14**; filing a term the book guided records every reading that volume guided for that form; a term the book never guided records nothing and says so; a second pass files 0; every content column of the published term row compared and **unmoved**; `GLOSSARY_HEADER` gains the fourth column and all three readers still drop the header by position; the re-render door's comparison still refuses a lost row, a moved cell and an empty render, measured over **copies** of all 17 records; a wording that contradicts a printed reading is **filed and named** in the report the grader reads. |
| **4** | **"The reading changed" becomes the forward half of the terminology review.** | A query over the recorded readings replaces `FORWARD_REVEAL_SHAPES`; on copies of the 17 records, 0 model calls, it finds the measured **266 / 129** classes and ranks them inside the existing 24-call bound; a fixture where a later volume guides a form differently puts that term on the agenda with **no phrase matching at all**; the phrase path stays for records that predate the column and the coverage report names which half produced the agenda. |
| **5** | **The revision door stops assuming newer is better** for a change in how a name is spoken. | A planted revision that contradicts a reading the book prints **repeatedly** is **named, not settled**; a planted genuine correction still settles; both outcomes print the guide and the choice side by side; 0 published rows edited. |
| **6** | **A published translation never carries the markup.** | The translator is still shown the annotated source; the translation, verify, retranslate and polish outputs are checked for ruby tags and a stray tag is a finding; the paragraph-alignment check is unmoved; the published artifacts of the offline loops contain **0** tags. |

Slice 1 is the one that decides whether this plan is safe. Slice 2 is the one that pays for slice 0 by removing
the workaround. Slices 3–5 are plan 08's slices 1–3, re-numbered, and they are what make "the reading changed"
answerable without a phrase list.

---

## 6. Open decisions, for the account owner

1. **When the corpus is re-extracted.** Nothing in this plan is observable on the real books until it is. It
   grows 133 chapter files and 17 whole-volume files by 46.76 %, re-runs the six extraction audits, and moves
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
