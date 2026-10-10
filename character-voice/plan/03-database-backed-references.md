# Proposal: a database behind the reference artifacts

**Status: PROPOSAL, not implemented.** This replaces §2–§4 of
[`02-compression-scheme.md`](02-compression-scheme.md) (the JSONL claim store) with a proper
database. That document's failure analysis (§1–2 of `01-…`), its injection ideas, and its cost
measurements still stand and are not repeated here.

Written 2026-10-10.

---

## 0. Why this is the right shape

The anchor fact from `02-compression-scheme.md` §0:

```
produced   118,218 characters of voice reference   (171,843,556 tokens)
consumed     4,000 characters, relevance-selected  (utils/translate/references.js:235)
```

The artifact's real contract is *"be a store good enough that a small, precisely-chosen slice of
it is the right guidance for this chapter."* That is a database contract, not a document
contract. Three things this codebase already does by hand would become queries:

| today | with a database |
|---|---|
| `pickRelevantSections` matches headings and quoted patterns against the chapter, then truncates at 4,000 chars | `facts_for_chapter(volume, chapter)` — exact, ranked, capped |
| the per-volume copy of `shared-wiki.md` is used instead of the series-root one "which would leak later-volume spoilers" (a convention in `docs/pipelines.md`) | volume-scoped visibility, enforced by the query |
| `contextHash` is a hash of whole files, so re-running any reference stage invalidates every draft of that volume | a hash of the volume's fact set, so volume 17's additions do not touch volume 1's drafts |

And the glossary is already a table pretending to be a document: **5,392 rows** of
term / rendering / section / notes, stored as markdown, parsed back out of markdown at every use,
with a disputes queue that is text-parsed too.

---

## 1. What is available here (checked, not assumed)

```
node v22.22.1        engines: >=22.19.0
require("node:sqlite") → DatabaseSync, StatementSync, constants, backup
```

`node:sqlite` works without a flag on this machine, but it is **experimental** and prints an
`ExperimentalWarning`. Current dependencies are the AI SDK, `@openharness/core`, `cheerio`,
`jszip`, `dotenv`, `file-type`, `undici`, `natural-orderby`, **`zod`** — and `docs/conventions.md`
says "keep CommonJS, no new frameworks".

Decision this design proposes:

- **Use `node:sqlite`.** No new dependency, no native build, and `backup` is exposed.
- **Wrap it behind one repository module** (`utils/reference-store/`) so the storage engine is
  swappable if `node:sqlite` changes under us. Nothing outside that module writes SQL.
- **Use the existing `zod`** to validate everything an agent proposes.
- `STAGE_CONCURRENCY` defaults to `1` (`configs/shared/settings.js:75`), so a single writer is the
  normal case. Enable WAL anyway, so a read never blocks the writer.

---

## 2. Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE volumes (
  volume INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  title  TEXT
);

CREATE TABLE chapters (
  volume             INTEGER REFERENCES volumes(volume),
  chapter_id         TEXT NOT NULL,
  ord                INTEGER NOT NULL,          -- reading order, from chapters.json
  file               TEXT NOT NULL,
  char_count         INTEGER,
  source_fingerprint TEXT,
  PRIMARY KEY (volume, chapter_id)
);

CREATE TABLE cast (
  key               TEXT PRIMARY KEY,            -- voicePrimaryName: 如月雨露（ジョーロ）【俺人格】 → 如月雨露
  display           TEXT NOT NULL,               -- the full heading, as rendered
  persona           TEXT,                        -- 俺人格 / 僕人格 / NULL
  aliases           TEXT NOT NULL DEFAULT '[]',  -- JSON
  first_seen_volume INTEGER,
  notes             TEXT
);

CREATE TABLE facts (
  id                  TEXT PRIMARY KEY,          -- v01-ch3-017
  key                 TEXT REFERENCES cast(key), -- NULL for non-character facts
  aspect              TEXT NOT NULL,             -- pronoun|catchphrase|register|address_term|
                                                 -- internal_voice|trajectory|relationship|pov|quirk|term_usage
  body                TEXT NOT NULL,             -- the claim, in prose
  examples            TEXT NOT NULL DEFAULT '[]',-- JSON array of source-language quotes
  formality           TEXT,
  evidence            TEXT NOT NULL,             -- JSON [{volume,chapter,line,quote}] — at least one, required
  established_volume  INTEGER NOT NULL,          -- which volume's reading produced this
  established_chapter TEXT,
  applies_from_volume INTEGER NOT NULL,          -- first volume of the story where it holds
  applies_to_volume   INTEGER,                   -- NULL = still holds
  status              TEXT NOT NULL DEFAULT 'active',  -- active|superseded|disputed|retracted
  supersedes          TEXT REFERENCES facts(id),
  confidence          REAL,
  source_stage        TEXT NOT NULL,             -- extract|merge|repair|verify
  owner_volume        INTEGER NOT NULL,          -- written by the harness, never by the agent (§3.2)
  owner_stage         TEXT NOT NULL,
  sealed              INTEGER NOT NULL DEFAULT 0,-- 0 = draft, the owner may update/delete it
  created_at          TEXT NOT NULL,
  row_version         INTEGER NOT NULL
);

CREATE INDEX idx_facts_scope ON facts(applies_from_volume, applies_to_volume, status);
CREATE INDEX idx_facts_key   ON facts(key, aspect, status);

-- Relational facts belong to two characters. This is the case a naive
-- per-character split loses (see 01-…md §6.1).
CREATE TABLE fact_characters (
  fact_id TEXT REFERENCES facts(id),
  key     TEXT REFERENCES cast(key),
  role    TEXT NOT NULL DEFAULT 'subject',       -- subject|agent|patient|witness
  PRIMARY KEY (fact_id, key, role)
);
```

### 2.1 The visibility rule — spoilers and corrections, derived rather than flagged

SQLite views cannot take parameters, so the view resolves supersession and the repository layer
supplies the volume. Two pieces:

```sql
-- The latest volume any of a fact's evidence comes from.
CREATE VIEW fact_evidence_ceiling AS
SELECT f.id AS fact_id, MAX(CAST(json_extract(e.value,'$.volume') AS INTEGER)) AS ceiling_volume
FROM facts f, json_each(f.evidence) e
GROUP BY f.id;

-- A fact is *showable at volume V* when:
--   it is not retracted,
--   it is not superseded by something that is not retracted,
--   its evidence ceiling is <= V   (no later-volume revelation leaks backwards),
--   and its applies-span covers V.
CREATE VIEW showable_facts AS
SELECT f.*, c.ceiling_volume
FROM facts f
JOIN fact_evidence_ceiling c USING (fact_id)
WHERE f.status <> 'retracted'
  AND NOT EXISTS (SELECT 1 FROM facts g WHERE g.supersedes = f.id AND g.status <> 'retracted');
```

The spoiler rule is **derived from the evidence, not from a flag a model has to set correctly**.
A fact established while reading volume 10 cannot be shown to the translator of volume 3, because
its evidence ceiling is 10. A fact established at volume 10 whose evidence is a line in volume 2
*can* be shown at volume 3 — it is a late discovery of something the volume-3 translator could
have found itself, and it is not a spoiler.

That distinction is the sharp edge of the whole design, and deriving it from evidence is what
makes it safe. It replaces today's convention ("use the per-volume wiki copy, not the root one")
with a rule the query enforces.

### 2.1.1 Probe run on this machine (2026-10-10, Node v22.22.1)

The schema questions were settled by running them, not by reading docs:

| probe | result |
|---|---|
| `json_extract` | works |
| `json_each` joined against a table | works — `[{volume:3,…},{volume:9,…}]` yields two rows |
| `json_each` **inside a view** | works — the `fact_evidence_ceiling` view above is valid as written |
| `PRAGMA journal_mode = WAL` on a file database | works |
| `require("node:sqlite").backup` | present, a function |
| a 2,000,000-character text column | works |

And the visibility rule was checked end to end: a fact whose evidence spans volumes 3 and 9 gets
`ceiling_volume = 9`, and `where ceiling_volume <= 3` correctly returns **nothing** for volume 3.
The spoiler guard is not a hope in this design; it is the query that already ran.

So: **evidence stays a JSON column**, and no separate evidence table is needed. The one caveat
left is that `node:sqlite` prints an `ExperimentalWarning` on every load — decide whether to silence
it or accept it in test output before the store appears in `npm test`'s output.

### 2.2 Frozen snapshots — what the translator actually saw

```sql
CREATE TABLE facts_at_volume (
  volume  INTEGER NOT NULL,
  fact_id TEXT NOT NULL REFERENCES facts(id),
  PRIMARY KEY (volume, fact_id)
);
```

Written **once**, when that volume's pre-production completes, from `showable_facts` at that
volume. Never edited afterwards.

With one database file per volume (§7) the file *is* the snapshot, so this table records something
narrower and still useful: which facts were showable **at the moment of sealing**, kept inside the
sealed file so the record explains itself. Three things depend on it:

1. **Idempotency that does not over-invalidate.** `contextHash` becomes a hash of the sealed fact
   set, not of whole files. Volume 17's facts cannot invalidate volume 1's drafts — which per-volume
   files already guarantee, since volume 1's file is sealed and never touched again. (Today
   `fingerprintReferences` hashes the full artifacts, so re-running the voice stage invalidates every
   draft of that volume — `utils/translate/references.js`, "safe direction: it may invalidate more
   than strictly necessary".)
2. **Reproducibility.** "What guidance did volume 3 chapter 7 actually get?" is a query against
   volume 3's file, answerable years later. Today the answer is a hash of files that have since
   changed.
3. **The consistency audit becomes joins.** Cross-artifact contradictions between the glossary, the
   voice reference, the wiki and the POV map are queries against one store instead of an AI reading
   four documents.

One consequence of per-volume files worth naming: the cross-volume check — *a character present at
volume v and missing at v+1* — no longer runs inside one database, because volume v+1's file is a
different file. It moves to the **copy-forward step** (§7.3), which is a better place for it: the
moment a character would be lost is the moment the copy is made, and the copy can be refused there.

---

## 3. The agent tool surface — the part that must not be improvised

**Agents must not be given SQL.** Not a style preference:

- AGENTS.md rule 2 — "The sandbox is the sandbox … Do not weaken it, and do not advertise a tool
  the sandbox would refuse."
- AGENTS.md rule 3 — "A guard the role can switch off is not a guard."
- The manager role already establishes the pattern: *"That tool list IS your menu: a move that is
  not on it is not a move you can make."*

A model handed `execute_sql` will eventually emit a `DELETE`, a `DROP`, or a query that reads
across the volume boundary and gets itself spoiled. So the tool set is **named, read-only,
parameterized queries with row caps**, plus a **write-by-proposal** channel.

### 3.1 Read tools

| tool | returns | cap |
|---|---|---|
| `cast_at(volume)` | who is in the cast as of that volume, with aliases and personas | all (small) |
| `facts_for(key, volume, {aspect, limit})` | that character's active facts at that volume | default 40 rows |
| `facts_for_chapter(volume, chapter_id, {limit})` | facts whose **evidence cites this chapter** | default 60 |
| `fact_history(key, aspect)` | the trajectory: every version and when it changed | all (small) |
| `search_facts(pattern, volume, {limit})` | text search over bodies/examples, volume-scoped | default 30 |
| `chapter_source(volume, chapter_id, {from, to})` | source lines — the existing `readFile` gate, unchanged | existing limits |

Every read tool returns **rows, not prose**, and every result states the budget it consumed:

```
4 facts returned (42 of 120 rows used this turn). 3 more facts exist for this character
that do not cite this chapter — call facts_for(key="如月雨露", volume=3).
```

That last sentence matters. The failure in `01-…md` §2.2 was an agent making 24 reads of a file it
could not read. A query tool without a budget and without a pointer to the next precise query
recreates exactly that thrash in a new shape. **Budgets and "here is the narrower query you
probably wanted" are part of the tool contract, not polish.**

### 3.2 Write tools — scoped by ownership, validated by code

An agent may **update and delete what it inserted for the volume it is working on**, and has **read
access to everything else** (within its volume-visibility scope). That is the right rule, and it is
better than a blanket "append only": a volume-3 agent correcting its own mis-dated claim is exactly
the fix we want, applied at the source.

| tool | effect |
|---|---|
| `insert_facts([...])` | code validates each against a **zod** schema, resolves `key` against `cast` (creating a cast entry only when genuinely new), requires ≥1 evidence item whose quote actually occurs at the cited `volume:chapter:line`, stamps the owner, inserts |
| `update_own_fact(id, …)` | same validation; **only rows this agent owns and this volume has not yet sealed** |
| `delete_own_fact(id, reason)` | **only rows this agent owns and this volume has not yet sealed** — see §3.3 |
| `challenge_fact(id, reason, evidence)` | the verb ownership alone is missing: you may not edit another volume's row, but you may write your own row that contradicts it and mark theirs `disputed`. Without this, a later book correcting an earlier one has nowhere to go |
| `cast_alias(key, alias)` | merges identities — the operation that prevents two entries for one character |

**Ownership is bound by the harness at launch, never read from a field the model writes.** Every
agent is already created with its volume folder fixed by the caller (`glossary/chunked.js:88`,
`style-guide/chunked.js:40`, `jump-in-wiki/chunked.js:45`) and every file mutation passes through
one `approve(call)` predicate (`ai/tools-fs.js:293`). The reference tools get the same treatment:
`createReferenceTools({ volume: 3, stage: "extract" })`, and the owner is written into the row by
that call. An agent that mislabels its own row cannot use it to claim someone else's, because the
label it writes is not the label the guard reads.

Enforcement is in the statement, not the prompt:

```sql
UPDATE facts SET body = :body, examples = :examples, row_version = row_version + 1
WHERE id = :id AND owner_volume = :currentVolume AND owner_stage = :currentStage
  AND sealed = 0;
```

A mismatched id changes **zero** rows, and the refusal names the row's real owner and says which
verb *is* available (`challenge_fact`). A refusal that only says "not allowed" cannot be acted on —
the same reason `utils/tickets` and `utils/patches` refuse by name. This is AGENTS.md rule 3: a
guard the role can switch off is not a guard, so there is no env knob on it.

### 3.3 The line in time: drafts are yours, published history is not

Ownership has a second boundary, and it is the one that protects the corpus.

```
before the volume's record is sealed   →  the agent's own rows are DRAFTS
                                          update and delete freely
after it is sealed                     →  those rows are part of the published record
                                          no delete; challenge or supersede instead
```

"Sealed" is the moment that volume's pre-production completes and its `facts_at_volume` snapshot is
written. Three things break if deletion is allowed past that line:

1. **Translations already built on the fact become unexplainable.** Volume 5's translation of a
   line was made using a fact volume 3 published. If volume 3's row is later deleted, "why does
   volume 5 say that?" has no answer — and §2.2's reproducibility promise is gone.
2. **The loss guard stops meaning anything.** "A character present at volume *v* and missing at
   *v+1*" is the carry-forward check expressed as a query. If vanishing is a legal operation, the
   query can no longer tell damage from editing.
3. **A frozen snapshot and the live table disagree**, and nothing detects the drift.

So: **delete is a draft-phase verb.** After sealing, being wrong is recorded as `disputed` or
`superseded`, which keeps the trajectory — and for character voice the trajectory is information,
not litter. This is also the honest reason the file sandbox has no `deleteFile` at all
(`ai/tools-fs.js:299`); the database inherits that stance for published rows and relaxes it only
where relaxing is genuinely safe.

### 3.4 Source reads are scoped too

Read access to other volumes' *facts* is safe, because facts are already volume-scoped. Read access
to other volumes' **source text** is not: a repair agent grepping for "where does this quote
actually appear?" can grep volume 10 and learn a plot reveal while working on volume 3. Source reads
get the same ceiling as fact reads — this volume and earlier — or the spoiler guard built into the
queries is bypassed through the file tools.

Refusals are by name with what *is* acceptable, the way `utils/tickets` and `utils/patches` refuse
things today — a refusal that only says "not allowed" cannot be acted on.

**A fact whose evidence does not verify is refused at the door.** That single rule is worth more
than the entire AI validator stage it replaces: it makes "systematic mis-dating of quirks across
chapters" impossible to write down, because a claim about chapter 3 that quotes a line from
chapter 7 is rejected by code before it becomes a fact.

### 3.5 The budget is tight by default, and escalation is a recorded grant

Decided by the account owner 2026-10-10: **tight by default; an agent that needs more asks the
delivery layer; when no delivery layer is driving the run, generous.**

Two things this must not become.

**Escalation is not a switch on the guard.** AGENTS.md rule 3 — "A guard the role can switch off is
not a guard" — and this repo already refuses env knobs on the banned-option filter, the manager's
action menu and the banned patch paths (gotchas 70, 75, 78). So escalation is not "the cap is now
higher". It is a **bounded grant for one turn, recorded**:

```
agent   "I need the full cast history for 如月雨露. 40 rows is not enough."
grant   120 rows, this turn only, reason written to the run ledger
result  every grant reported in the post-mortem, next to every other decision
```

**The grant has a ceiling, and it is not a number.** The last run died at
`prompt (263012 tokens) leaves no room to answer in the context (262144)`. A grant that can push a
turn past the window is not an escalation — it is the same crash with better paperwork. So the
ceiling is computed from the same formula that already decides whole-volume vs chapter-by-chapter
(`utils/tokens/budget.js`):

```
grantable rows ≤ the rows that fit in
                 roleWindow × 0.75 − outputReserve − everything already in this turn
```

An agent may be granted more room only where there *is* room.

**"Generous" must not mean "uncapped."** This is the half of the decision worth watching. Running
without the delivery layer (`npm run pipeline`) means nobody is there to grant, so the default
becomes generous — and *generous is the shape that killed the last run*. Generous should mean "as
much as this model can actually hold in one turn", computed from the same budget formula, never
unlimited. Otherwise whether the pipeline respects the model's window depends on which entry point
was used, and the window is a property of the hardware, not of the runner.

One upside worth naming: the escalation request is itself a measurement. A run that escalates often
is telling you the default is wrong, and `utils/ledger` already records attempts and outcomes. "How
often do agents ask, and were they granted" is the data that turns §3.1's guessed row counts into
tuned ones.

---

## 4. What the stages become

```
extract      per chapter, one call — UNCHANGED (1.1M tokens, already structured, already correct)
merge        code: insert proposals, resolve cast identity, verify evidence
             only genuine judgment questions go to a model, each with ~1k tokens:
               "are these two names the same character?"
               "is this contradiction a change or an error?"
audit        code: the integrity queries in §5, then a graded SAMPLE of characters
repair       scoped to a character or a chapter: query, propose, done
render       code → character-voice.md, glossary.md, wiki.md, pov-map.md — same names, same shapes
```

The published files stay. That is what keeps the 105 references across 30 code files and the 11
prompt files working, and what keeps `hasDocumentShape`, `parseVoiceSections` and the acceptance
test's `voiceSections` signal meaningful. **The database is the source; the documents are views.**

---

## 5. The deterministic audit, as queries

Every one of these is free, and every one of them corresponds to something that actually went
wrong in the failed run:

| query | catches |
|---|---|
| facts with zero evidence, or evidence whose quote does not occur at the cited line | fabricated or mis-dated claims |
| facts whose `established_volume` is less than the volume of their own evidence | impossible provenance |
| facts whose `applies_from_volume` precedes their earliest evidence | claims about events that have not happened yet |
| two `cast` rows whose `key` differs only by alias, with no alias link | a character split in two |
| a `key` in the source file of a copy-forward that is missing from the copy | **a character lost between volumes** — the carry-forward guard, checked at the moment the copy is made (§7.3) |
| a copy whose row count differs from its source's, or whose recorded source hash does not match | a damaged volume silently infecting the next one |
| a `supersedes` chain that is circular or retracts a fact with no replacement | silent deletion dressed as a correction |
| rendered output with a line longer than `envMaxLineLength()`, or fewer `### ` sections than the cast | the exact damage in `01-…md` §2.1 |

Then the AI grader scores a **sample** — three characters at random, plus every character a query
flagged — instead of reading a 250,000-character document. Today that stage costs 60.3 million
tokens auditing a document whose damage was structural and therefore mechanically visible.

---

## 6. This also fixes what the delivery layer measures

`utils/delivery-verify/signals.js` has ~18 signals and most of them count whether files exist and
how many entries they hold. That is why the failed run was scored **`improved`** while publishing a
48/100 reference with a shredded tail.

A store makes quality signals computable deterministically, which is the fix for that:

| new signal | meaning |
|---|---|
| `factsWithVerifiedEvidence` | claims whose evidence actually checks out — a real quality measure, not a count |
| `factsDisputed` | contested claims still feeding the translator |
| `castLost` | characters present at volume *v* and missing at *v+1* |
| `factsPerChapter` | how much guidance each chapter actually received — the thing the translator used |

`voiceSections` (a count of headings) stays as a shape check, but it stops being the main thing.

---

## 7. One database per volume, copied forward

Decided by the account owner 2026-10-10. **Not one series-wide database.**

```
volume 01/series.db      built by volume 01's agents
volume 02/series.db      a copy of volume 01's, then volume 02's agents add to it
volume 03/series.db      a copy of volume 02's, then volume 03's agents add to it
   …
```

A volume's translation stage reads **only its own volume's file**. That file contains this volume's
findings and every earlier volume's findings, and it is *physically incapable* of containing a later
volume's. The spoiler guard stops being a query the code must remember to write and becomes a fact
about the filesystem: you cannot leak what is not there.

This is not a new idea in this codebase — it is the existing one, applied to the store instead of to
the wiki. `docs/pipelines.md:186`: the translator uses the per-volume copy of `shared-wiki.md` and
not the series-root one, "which would leak later-volume spoilers"; `utils/translate/references.js:219`
calls that an "observed design constraint". The per-volume database makes that constraint structural
instead of conventional.

### 7.1 What the copy-forward buys

| property | why it holds |
|---|---|
| **Spoiler isolation is structural** | volume 3's file has no volume 10 rows to leak |
| **Idempotency stops over-invalidating** | volume 1's translation depends on volume 1's file, which is sealed and never changes again — the `fingerprintReferences` problem (§2.2) disappears without needing a new hash rule |
| **A damaged volume is bounded** | the damage is one file, and `utils/artifacts/preproduction.js` already declares expected outputs per volume folder |
| **The chain is auditable** | each copy records the hash of the file it was copied from, so "which record did volume 5 work from?" is answerable forever |
| **Storage is not a concern** | volume 01's 223 claims are 240 KB as today's JSON; a normalized table is comparable or smaller. Even if volume 17's file reaches a few megabytes, seventeen growing copies of a series this size are tens of megabytes — noise next to 17 EPUBs |

### 7.2 What it does not buy — the honest half

**Damage still propagates forward.** Volume 4's file was copied from volume 3's. If volume 3's is
corrupted, volume 4's is corrupted the same way, and only re-deriving from volume 2's copy fixes it.
"A damaged volume is disposable" is strictly true only for the *last* volume.

What makes this survivable is the new cost shape, not the copy shape. Re-deriving a volume means
re-running the **cheap** per-chapter extract and the **code** merge, then copying forward. Under
today's design that means another 172-million-token run; under this one, a few million. The chain is
rebuildable because the expensive part of it stopped being expensive.

### 7.3 The copy is a guarded operation, not a file copy

Copying forward is the exact moment damage propagates, so it is a checked step:

- refuse to copy a database that fails the §5 integrity queries — a corrupt volume does not get to
  infect the next one
- record the source file's row counts and content hash inside the copy
- after copying, verify the copy's row count equals the source's
- a copy that fails is a **HIGH** post-mortem finding, not a warning

Two hard rules from this repo's own history still apply:

- **Resolve each path at call time from `SERIES_LOCATION`, never at require time.** Gotcha 79 and
  gotcha 94 exist precisely because a path frozen at load time silently becomes the repo fallback on
  every run. `configs/run-state.js` is the pattern to follow — and per-volume files make this *more*
  important, not less, because the path now depends on which volume is running.
- **Never let the store become a banned patch path by accident.** `utils/tickets`, `utils/patches`,
  `utils/ledger`, `utils/runlock` are protected; a repository module that owns the corpus's source of
  truth belongs in the same class (AGENTS.md §3), and that has to be decided *when it is created*,
  not discovered later.

Bidirectional reconstructibility remains the safety net: import the existing artifacts → database,
then render → diff against the files on disk. If the diff is clean, the round trip is proven and the
database is never the only copy of anything.

---

## 8. Migration, in slices that each keep `npm test` green

Per gotcha 69, every test uses a throwaway fixture series (`test/fixture-series.js`); none may
reach the real 17 volumes.

1. **Probe `node:sqlite`** on this machine's Node. **Done 2026-10-10** — see §2.1.1: JSON1 works,
   `json_each` works inside a view, WAL works, `backup` is present, and the volume-scoped spoiler
   filter returns the right rows. Remaining sub-question: what to do about the `ExperimentalWarning`
   on load so it does not pollute `npm test` output.
2. **`utils/reference-store/`** — schema, migrations, the repository API, **no agent tools yet**. The
   per-volume path is resolved at call time from `SERIES_LOCATION` plus the volume, following
   `configs/run-state.js` (gotchas 79, 94). Decide here whether the folder is a banned patch path
   (§10.2.3), not later. Test: schema round-trips; a fact without evidence is refused; a fact whose
   quote is not at the cited line is refused; the file path follows the volume and never falls back
   to the repo.
3. **Copy-forward as a guarded step** (§7.3) — integrity-check volume N−1's file, copy it, record the
   source hash and row counts, refuse a corrupt source. Test: a planted corrupt source is refused and
   reported HIGH; a clean copy has identical row counts.
4. **Import both artifacts for one volume and render them back**; the diff must be clean for both.
   One store, two thin adapters (§10.1). This is the slice that proves the database is not a second
   source of truth.
5. **Sealing and ownership** — `sealed`, `owner_volume`, `owner_stage`, stamped by the harness. Test:
   an agent updates and deletes its own unsealed rows; the same call against another volume's row
   changes **zero** rows and returns a refusal naming the real owner and pointing at
   `challenge_fact`; after sealing, delete is refused.
6. **Replace the AI validators** with the §5 queries plus a sampled grade. Biggest cost line,
   narrowest change.
7. **Give the pre-production agents the read tools** (§3.1) with tight budgets and the escalation
   path (§3.5). Test against the scripted endpoint in `test/fake-backend.js`, including a model that
   asks for more than the window can hold — that grant must be **refused**, not honoured.
8. **Two-tier injection** into the translator (`utils/translate/references.js`), bumped through
   `REFERENCE_SELECTION_VERSION` so dependent drafts invalidate deliberately (gotcha 27). Test: the
   card tier is never dropped; the full tier is ranked by appearance in the chapter; a volume-N
   translation cannot see a volume-N+1 fact.
9. **Then, and only then, the repair loop** as query-and-propose.

Slices 1–6 change no agent's behaviour and no prompt. Slices 7–9 are the redesign.

Measure at the end of slice 6 and again at the end of slice 9 with `npm run pipeline-loop` and the
prompt audit in `test/prompt-audit.js` — the cost projections in `02-compression-scheme.md` §5 are
estimates, and the point of measuring is to find out whether they were right before a real volume
pays for being wrong.

---

## 9. Risks, honestly

1. **`node:sqlite` is experimental.** The repository-module wrapper is the mitigation, and the
   engine floor is already `>=22.19`. The alternative — a native SQLite dependency — collides with
   "keep CommonJS, no new frameworks" and with a pipeline that runs inside a container.
2. **A query tool can recreate the thrash.** 24 reads of an unreadable file becomes 60 queries of a
   readable one, and the context still fills. Budgets, row caps, and the "here is the narrower
   query" hint are load-bearing, not nice to have.
3. **Getting the temporal model wrong is worse than prose.** The spoiler rule and the
   late-discovery-correction rule (§2.1) must be pinned in tests with real cases, because a wrong
   rule either leaks future volumes into an early translation or starves a later translation of
   facts it needs.
4. **Two sources of truth drift silently** if rendering is not authoritative. Rule: the database is
   authoritative, the documents are generated, and a test asserts the round trip.
5. **Free text in typed columns.** A model will write prose into `body`. That is fine — but the
   *shape* is validated by code, and `aspect` must be a closed vocabulary or the store degrades
   into a pile of notes nobody can query.
6. **Not everything fits a fact table.** Style rules are prescriptive, not factual; the wiki is
   narrative. Do not force all four artifacts into one schema on the first pass. Character voice
   and the glossary fit; start there.
7. **Trajectory claims remain the make-or-break detail** (`02-compression-scheme.md` §7.1).
   `aspect='trajectory'` plus `fact_history` is the mechanism, but the extract stage has to be
   asked for them explicitly or they will not exist, and the store will be a worse system than the
   prose document it replaced.

---

## 10. Decisions taken (2026-10-10)

| question | decision | where |
|---|---|---|
| one series-wide database, or one per volume? | **One per volume, copied forward.** Volume N's file is a copy of volume N−1's, then volume N's agents add to it. Spoiler isolation becomes structural, and each volume's translation depends only on a sealed file that never changes again | §7 |
| committed with the books, or rebuilt on demand? | **Committed**, in the volume folder next to the book. It is the source of truth for the rendered artifacts, and rebuilding it *is* the expensive part | §7 |
| may an agent update what it wrote? | **Yes** — scoped to rows it owns, for the volume it is working on, while that volume is still unsealed. Ownership is stamped by the harness at launch, never by the agent | §3.2 |
| may it delete? | **Only its own unsealed rows.** Once a volume's record is sealed, published facts are contested or superseded, never removed | §3.3 |
| may it read what it does not own? | **Yes**, within its volume's ceiling — and source-text reads get the same ceiling, or the file tools become a way around the spoiler guard | §3.4 |
| how much may an agent read? | **Tight by default**, escalated to the delivery layer as a recorded, bounded grant. Generous when no delivery layer is driving — but generous means "as much as this model can actually hold", never unlimited | §3.5 |
| which artifacts move in first? | **Both at once** — the glossary and the character-voice reference, on one store layer with two thin adapters | §10.1 |

### 10.1 What "both at once" costs, and how to keep it safe

Doing the glossary and the voice reference together means two carry-forward guards, two renderers and
two sets of downstream readers change in the same slice. The mitigation is to split the work by layer
rather than by artifact:

- **one** store: schema, migrations, integrity queries, the copy-forward step, the agent tool surface
- **two** thin adapters: glossary rows ↔ the store, voice claims ↔ the store — each with its own
  renderer and its own round-trip test

The safety net for doing them together already exists. `npm run pipeline-loop` runs the whole pipeline
against a two-volume fixture and then audits what the pipeline asked the model; both artifacts are
already in that fixture. A regression in either one shows up there instead of in a 13-hour run.

### 10.2 Still open

1. **Trajectory claims.** How much cross-chapter narrative observation must the store preserve?
   `aspect='trajectory'` plus `fact_history` is the mechanism, but the extract stage has to be asked
   for them explicitly or they will not exist — and then the store is a worse system than the prose
   document it replaced. This is the make-or-break detail (§9.7).
2. **Sample size for the graded audit.** "Three characters at random" is a guess. `npm run calibrate`
   is the existing harness for finding out how small a sample can get before the grade stops meaning
   anything.
3. **May the dev team change the schema?** A migration changes what every downstream stage can see,
   which argues for putting `utils/reference-store/` in the same protected class as the ledger and the
   ticket channel. Decide it when the folder is created, not later (AGENTS.md §3).
4. **What happens to the series-root cumulative files** (`glossary.md`, `shared-wiki.md` at the series
   root) once every volume carries its own database? Rendered from the newest volume's store, or
   dropped in favour of per-volume rendering?
5. **The damaged volume 01.** Its voice reference is shredded and 96.6% of it was never used. The
   cheap repair is to re-run the per-chapter extract (1.1M tokens, ten calls, it performed perfectly)
   and let the code merge build its store — rather than re-running the 172-million-token shape that
   damaged it. That argues for building the store layer *before* redoing volume 01, so it is redone
   once, under the new shape.
