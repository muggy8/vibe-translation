/**
 * utils/reference-store/schema.js — the tables, the views, and the version stamp.
 *
 * This is doc 03 §2 transcribed, with three additions and one deviation, all of them
 * recorded here so a reader of the schema can tell which lines came from the design and
 * which came from building it:
 *
 *   - `facts.section` and `facts.label` (the deviation, §2.1 below): the two artifacts the
 *     store has to reproduce are **sectioned** (the glossary is one table per `## `
 *     heading) and **labelled** (the voice reference renders one bullet per kind of claim,
 *     under the artifact's own wording). `aspect` is the closed vocabulary queries run on;
 *     `label` is what the renderer prints. Without them the store can hold the facts but
 *     cannot reproduce the document, and "the database is authoritative, the documents are
 *     views" (doc 03 §9.4) is a promise it cannot keep.
 *   - `facts.ord`: rendering has to be byte-identical across two runs of the same data
 *     (slice 4's criterion), which needs an order that is stored rather than implied.
 *   - `copy_provenance` and `challenges`: doc 03 §7.1 ("each copy records the hash of the
 *     file it was copied from") and §3.2 (`challenge_fact`) both ask for a record, and a
 *     record that only exists in a log file is not answerable "years later" (§2.2).
 *
 * Migrations are a list, not an edit-in-place. A migration changes what every downstream
 * stage can see (doc 03 §10.2.3), which is one of the reasons this folder is a protected
 * patch path.
 *
 * @module utils/reference-store/schema
 */

const { engineInfo } = require("./db");
require("../../types"); // JSDoc type definitions

// ─── The closed vocabularies ──────────────────────────────────────────────────

/**
 * The kinds of claim the store can hold (doc 03 §9.5: `aspect` must be a closed
 * vocabulary or the store degrades into a pile of notes nobody can query).
 *
 * The first ten are doc 03 §2's list. `appearance` is an addition the voice reference
 * needs: it carries an "Appears in" line, and a renderer that cannot store it cannot
 * reproduce the artifact.
 *
 * `unclassified` is the fallback, and its NAME is part of the guard. Doc 03 risk 5 is
 * exactly this failure — a catch-all aspect quietly becoming where everything lands — so
 * the value is called what it is instead of something that reads like a category, and
 * `integrity.js` counts unclassified facts per volume so the number appears in the
 * post-mortem on every run. Keeping a fallback is fine; hiding it is not (review 05 §2.3).
 *
 * @type {string[]}
 */
const FACT_ASPECTS = [
  "pronoun",
  "catchphrase",
  "register",
  "address_term",
  "internal_voice",
  "trajectory",
  "relationship",
  "pov",
  "quirk",
  "term_usage",
  "appearance",
  "unclassified",
];

/**
 * The two kinds of evidence a fact may cite (review 05 §3.6).
 *
 * `quote` asserts the book PRINTS this string, and cites a line where it occurs.
 * `governs` asserts this row is the decision made about a passage that IS in the book, and
 * cites a real line whose text the row is about. Both are checked by code against the same
 * cited line; what differs is the claim the citation supports, and the difference is stored
 * rather than assumed. There is no third kind and no "no evidence needed" path.
 *
 * @type {string[]}
 */
const EVIDENCE_KINDS = ["quote", "governs"];

/**
 * How a cited line matched the quote (review 05 §3.1 condition 2).
 *
 * `verbatim` — the book prints this string on that line.
 * `skeleton` — the book prints these Han characters in this order on that line, with reading
 * aids written between them (如月雨露 against 如月きさらぎ雨あま露つゆ).
 * An auditor has to be able to tell the two claims apart, so the store records which one
 * fired instead of leaving it to be inferred from the quote.
 *
 * @type {string[]}
 */
const EVIDENCE_MATCHES = ["verbatim", "skeleton"];

/**
 * The aspects that count as a character-voice claim.
 *
 * The coverage question is "does the character-voice reference say anything about this
 * character", and two aspects in the vocabulary are not an answer to it: `term_usage` is a
 * glossary row, and `appearance` is what the reference says about whether the character is in
 * the volume at all. A store that let either one count would report full coverage while saying
 * nothing about anyone.
 *
 * @type {string[]}
 */
/**
 * The stage whose rows are **candidates**, not record content.
 *
 * A store holds two kinds of row once the pipeline starts writing to it: the rows that came out of
 * a published document or a deliberate merge, and the claims the extraction pass pulled out of the
 * book before any agent decided whether to put them in the document. Only the first kind is the
 * record, so only the first kind is rendered back and only the first kind counts as coverage.
 * Without that line between them, a reference that lost a character would read as fully covered as
 * long as the extractor had noticed the character — the exact false pass this store exists to
 * prevent — and the published files would start carrying sentences no agent ever put in them.
 */
const EXTRACTION_SOURCE_STAGE = "extract";

/**
 * The stage a document import opens its handle with, and therefore the stamp every row that came
 * out of a published document carries. Kept next to `EXTRACTION_SOURCE_STAGE` because the two are
 * one decision: which rows are the record, and which are candidates.
 */
const DOCUMENT_SOURCE_STAGE = "import";

/**
 * The stage a **rebuild** opens its handle with, and the stamp every row it adopts carries.
 *
 * `rebuild` is record content, not a candidate: a reference rebuilt from a volume's extraction output
 * is a published artifact, and it renders and counts as coverage like any other document row. It is a
 * separate stage rather than a reuse of `import` for one reason — the audit has to be able to tell a
 * reference an author wrote from one code adopted from the extractor's claims, and `rebuildVoiceFrom
 * Extraction` is the only code in the repository allowed to stamp it. Adding the value changes no
 * table, no column and no constraint, so it needs no migration; what it changes is who may write a
 * row, and that is stated here rather than in a CHECK clause the store's own write scope already
 * enforces.
 */
const REBUILD_SOURCE_STAGE = "rebuild";

/** What a fact can be, and the only four values `status` accepts. */
const FACT_STATUSES = ["active", "superseded", "disputed", "retracted"];

/** Which stage of the pipeline wrote a fact (doc 03 §4). */
const SOURCE_STAGES = ["extract", "merge", "repair", "verify", "import", "rebuild"];

/** The roles a character can play in a relational fact (doc 03 §2). */
const FACT_CHARACTER_ROLES = ["subject", "agent", "patient", "witness"];

// ─── Version ──────────────────────────────────────────────────────────────────

/** The schema this build of the code writes. */
const SCHEMA_VERSION = 6;

/**
 * The migrations, oldest first. Version 1 is the whole design as built.
 *
 * A new slice that changes the shape adds an entry here and never edits version 1: a
 * volume's file is committed with the books, so an old file has to be upgradable by the
 * code that is running now.
 *
 * @type {Array<{version: number, name: string, up: string[]}>}
 */
const MIGRATIONS = [
  {
    version: 1,
    name: "initial reference store",
    up: [
      `CREATE TABLE IF NOT EXISTS store_info (
         key   TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,

      `CREATE TABLE IF NOT EXISTS volumes (
         volume INTEGER PRIMARY KEY,
         folder TEXT NOT NULL,
         title  TEXT
       )`,

      `CREATE TABLE IF NOT EXISTS chapters (
         volume             INTEGER REFERENCES volumes(volume),
         chapter_id         TEXT NOT NULL,
         ord                INTEGER NOT NULL,
         file               TEXT NOT NULL,
         char_count         INTEGER,
         source_fingerprint TEXT,
         PRIMARY KEY (volume, chapter_id)
       )`,

      `CREATE TABLE IF NOT EXISTS cast (
         key               TEXT PRIMARY KEY,
         display           TEXT NOT NULL,
         persona           TEXT,
         aliases           TEXT NOT NULL DEFAULT '[]',
         first_seen_volume INTEGER,
         notes             TEXT
       )`,

      `CREATE TABLE IF NOT EXISTS facts (
         id                  TEXT PRIMARY KEY,
         key                 TEXT REFERENCES cast(key),
         aspect              TEXT NOT NULL,
         label               TEXT,
         section             TEXT,
         body                TEXT NOT NULL,
         examples            TEXT NOT NULL DEFAULT '[]',
         formality           TEXT,
         evidence            TEXT NOT NULL,
         established_volume  INTEGER NOT NULL,
         established_chapter TEXT,
         applies_from_volume INTEGER NOT NULL,
         applies_to_volume   INTEGER,
         status              TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','superseded','disputed','retracted')),
         supersedes          TEXT REFERENCES facts(id),
         confidence          REAL,
         source_stage        TEXT NOT NULL,
         owner_volume        INTEGER NOT NULL,
         owner_stage         TEXT NOT NULL,
         sealed              INTEGER NOT NULL DEFAULT 0,
         created_at          TEXT NOT NULL,
         updated_at          TEXT,
         row_version         INTEGER NOT NULL,
         ord                 INTEGER NOT NULL
       )`,

      `CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(applies_from_volume, applies_to_volume, status)`,
      `CREATE INDEX IF NOT EXISTS idx_facts_key   ON facts(key, aspect, status)`,
      `CREATE INDEX IF NOT EXISTS idx_facts_owner ON facts(owner_volume, owner_stage, sealed)`,

      `CREATE TABLE IF NOT EXISTS fact_characters (
         fact_id TEXT REFERENCES facts(id),
         key     TEXT REFERENCES cast(key),
         role    TEXT NOT NULL DEFAULT 'subject'
                 CHECK (role IN ('subject','agent','patient','witness')),
         PRIMARY KEY (fact_id, key, role)
       )`,

      // doc 03 §2.2 — the facts that were showable at the moment a volume was sealed.
      // Written once, never edited afterwards.
      `CREATE TABLE IF NOT EXISTS facts_at_volume (
         volume  INTEGER NOT NULL,
         fact_id TEXT NOT NULL REFERENCES facts(id),
         PRIMARY KEY (volume, fact_id)
       )`,

      // doc 03 §7.1 — "each copy records the hash of the file it was copied from".
      `CREATE TABLE IF NOT EXISTS copy_provenance (
         volume        INTEGER PRIMARY KEY REFERENCES volumes(volume),
         source_volume INTEGER NOT NULL,
         source_file   TEXT NOT NULL,
         source_sha256 TEXT NOT NULL,
         source_rows   TEXT NOT NULL,
         copied_rows   TEXT NOT NULL,
         copied_at     TEXT NOT NULL,
         ok            INTEGER NOT NULL DEFAULT 1,
         note          TEXT
       )`,

      // doc 03 §3.2 — `cast_alias` merges identities. The merge is recorded because a
      // character merged into the wrong character is the one operation that can make a
      // whole set of facts disappear from a query, and "who merged what, and why" has to
      // be answerable afterwards.
      `CREATE TABLE IF NOT EXISTS cast_merges (
         survivor     TEXT NOT NULL REFERENCES cast(key),
         merged       TEXT NOT NULL,
         reason       TEXT,
         moved_facts  INTEGER NOT NULL DEFAULT 0,
         created_at   TEXT NOT NULL,
         PRIMARY KEY (survivor, merged)
       )`,

      // doc 03 §3.2 — `challenge_fact` writes a row of its own AND records the claim
      // against the row it is answering. The record is what makes "who said this was
      // wrong, and when" answerable after the fact has been superseded.
      `CREATE TABLE IF NOT EXISTS challenges (
         id            INTEGER PRIMARY KEY,
         fact_id       TEXT NOT NULL REFERENCES facts(id),
         challenger_id TEXT NOT NULL REFERENCES facts(id),
         reason        TEXT NOT NULL,
         evidence      TEXT NOT NULL,
         created_at    TEXT NOT NULL
       )`,

      // doc 03 §2.1 — the two views. SQLite views take no parameters, so the view
      // resolves supersession and the repository layer supplies the volume.
      `CREATE VIEW IF NOT EXISTS fact_evidence_ceiling AS
         SELECT f.id AS fact_id,
                MAX(CAST(json_extract(e.value,'$.volume') AS INTEGER)) AS ceiling_volume
         FROM facts f, json_each(f.evidence) e
         GROUP BY f.id`,

      `CREATE VIEW IF NOT EXISTS showable_facts AS
         SELECT f.*, c.ceiling_volume
         FROM facts f
         JOIN fact_evidence_ceiling c ON c.fact_id = f.id
         WHERE f.status <> 'retracted'
           AND NOT EXISTS (SELECT 1 FROM facts g WHERE g.supersedes = f.id AND g.status <> 'retracted')`,
    ],
  },

  {
    version: 2,
    name: "document prose, merged cast entries, closable challenges",
    // Review 05 §3.3, §3.4 and §3.5. Added as a migration rather than an edit to version 1:
    // a volume's file is committed with the books, so a file written by the slice-2 build has
    // to be brought up by the code that is running now, and `applySchema` is the only thing
    // allowed to change what a store looks like.
    up: [
      // §3.4 — a document's own prose. The real glossary opens with a title line and two
      // style-policy paragraphs AND carries a paragraph inside `## Real-World References`; the
      // voice reference opens with a preamble. Parsed and then dropped is how slice 4 failed to
      // diff clean on volume 01. Ordered, per document and per section, rendered back verbatim.
      `CREATE TABLE IF NOT EXISTS document_prose (
         document TEXT NOT NULL,
         ord      INTEGER NOT NULL,
         kind     TEXT NOT NULL CHECK (kind IN ('title','preamble')),
         section  TEXT,
         text     TEXT NOT NULL,
         PRIMARY KEY (document, ord)
       )`,

      // §3.3 — a merged cast entry is superseded, not deleted. The row stays, marked with the
      // entry it joined, so a set of published facts can never vanish from the record because
      // someone merged two characters.
      `ALTER TABLE cast ADD COLUMN merged_into TEXT REFERENCES cast(key)`,

      // §3.5 — a challenge is closable. `outcome` is null while it is open.
      `ALTER TABLE challenges ADD COLUMN outcome TEXT CHECK (outcome IN ('uphold','accept'))`,
      `ALTER TABLE challenges ADD COLUMN resolved_at TEXT`,
      // …and the resolution is attributed, because "who closed this dispute, from which
      // volume" is the question a later reader asks when the answer changed the guidance.
      `ALTER TABLE challenges ADD COLUMN resolved_by_volume INTEGER`,
      `ALTER TABLE challenges ADD COLUMN resolved_by_stage TEXT`,
    ],
  },
  {
    version: 3,
    name: "slice 6 — what the source text says about each character",
    // Slice 6's coverage rule needs a fact that the artifacts cannot supply: whether a
    // character appears in THIS volume's own text. It is measured by code from the chapter
    // files (the same files the evidence rule reads), never asserted by a document or a model,
    // because "the reference covers fewer characters than the cast" is only a real finding when
    // the missing character was actually in the book. An absence claim has no quote to cite, so
    // it is a measurement here rather than a fact in `facts` — the store's own rule (no claim
    // without a checkable citation) has no exemption, and this is not one. `matched` records WHICH
    // rule proved it — `verbatim` or `skeleton` — because a presence measured only by exact string
    // comparison would report half the cast as absent, and that looks identical to a cast that is
    // genuinely not there.
    up: [
      `CREATE TABLE IF NOT EXISTS cast_presence (
         volume  INTEGER NOT NULL,
         key     TEXT NOT NULL REFERENCES cast(key),
         present INTEGER NOT NULL CHECK (present IN (0,1)),
         matched TEXT,
         chapter TEXT,
         line    INTEGER,
         PRIMARY KEY (volume, key)
       )`,
    ],
  },
  {
    version: 4,
    name: "slice 6 recalibration — every place a name occurs, not the first one",
    // The coverage rule asks "is this character barely in this volume, or are they the book?", and
    // one row per character cannot answer it: the measurement stopped at the first match, so a
    // character named once and a character named in every chapter looked identical. `cast_presence`
    // stays the per-character answer — every existing reader of it keeps working, including the
    // report's "who is in this volume's text" section — and gains the two counts the rule needs. The
    // detail goes in its own table: one row per (volume, character, chapter, line, name), each with
    // the rule that proved it, so the audit can say HOW it knows a character is in the volume instead
    // of only that they are. Same source files, same matching rule; this migration only stops
    // throwing the rest of the measurement away.
    up: [
      `CREATE TABLE IF NOT EXISTS cast_presence_match (
         volume  INTEGER NOT NULL,
         key     TEXT NOT NULL REFERENCES cast(key),
         chapter TEXT NOT NULL,
         line    INTEGER NOT NULL,
         name    TEXT NOT NULL,
         matched TEXT NOT NULL CHECK (matched IN ('verbatim','skeleton')),
         PRIMARY KEY (volume, key, chapter, line, name)
       )`,

      `CREATE INDEX IF NOT EXISTS idx_presence_match_chapters ON cast_presence_match(volume, key, chapter)`,

      // The summary's own answer to "how much do they appear", stored rather than re-derived, so a
      // reader of `cast_presence` does not have to know the detail table exists to see the difference
      // between a character in one chapter and a character in ten.
      `ALTER TABLE cast_presence ADD COLUMN chapters INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE cast_presence ADD COLUMN matches INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 5,
    name: "slice 8 — the chapter's own title, and the record's reopen history",
    // Two things this slice needs the record to answer by itself, rather than by a log file somebody
    // has to still have.
    //
    // **A chapter's title.** The chapter list the extraction wrote (`*-bundle.meta.json`) has always
    // carried the real heading — `第二章 僕と俺のバトンタッチ` — and `listVolumeChapters` has always
    // read it, but `registerChapter` threw it away. Every artifact that cites a chapter has therefore
    // been naming it `ch2`, which is a filename, not a name. The rendered POV map is the artifact where
    // that hurts most: a reader tracing a viewpoint break wants the chapter the book calls something,
    // and the volume's own table of contents is sitting in a file next to the record.
    //
    // **The reopen history.** A sealed volume is a volume a later volume was built on. Reopening one is
    // therefore an act with consequences beyond itself, and `copy_provenance` already records the hash
    // of the file each copy was made from — which answers "has the source changed?" but not "was the
    // source *redone*, and why?". A reason that only exists in a console log is not answerable from the
    // record years later (doc 03 §2.2), and the staleness question — is this volume's copy built on a
    // volume that has since been rebuilt? — has to be answerable from the two tables together.
    up: [
      `ALTER TABLE chapters ADD COLUMN title TEXT`,

      `ALTER TABLE copy_provenance ADD COLUMN source_reopens INTEGER NOT NULL DEFAULT 0`,

      `CREATE TABLE IF NOT EXISTS record_reopens (
         volume         INTEGER NOT NULL,
         reopened_at    TEXT NOT NULL,
         reason         TEXT NOT NULL,
         was_sealed     INTEGER NOT NULL DEFAULT 0,
         sealed_at      TEXT,
         rows_at_reopen TEXT NOT NULL DEFAULT '{}',
         copies_affected TEXT NOT NULL DEFAULT '[]',
         PRIMARY KEY (volume, reopened_at)
       )`,

      `CREATE INDEX IF NOT EXISTS idx_record_reopens_volume ON record_reopens(volume, reopened_at)`,
    ],
  },
  {
    version: 6,
    name: "slice 9 — the name the extraction gave a claim, kept when the store files it elsewhere",
    // A claim's roster key used to be the only place this record remembered who the claim was about. That
    // is fine while every name the extraction produced becomes a roster entry, and it stops being fine
    // the moment the store refuses to make one: a bare first-person pronoun is not a character name, and
    // filing 282 claims under `俺` put the protagonist in two places at once (gotcha 115).
    //
    // So the store now sometimes files a claim under a different entry than the name it was written
    // under, and sometimes files it with no entry at all. Both are decisions a reader has to be able to
    // check, and a null key with nothing beside it is not a decision — it is a claim that lost its
    // subject. `extracted_as` is the name the extraction actually wrote, kept beside the claim whether
    // the store resolved it onto somebody or refused to invent somebody for it.
    up: [
      `ALTER TABLE facts ADD COLUMN extracted_as TEXT`,

      // The audit's question is "which claims are floating, and what did the extraction call them", so
      // the unattached ones have to be findable without scanning every row.
      `CREATE INDEX IF NOT EXISTS idx_facts_extracted_as ON facts(extracted_as) WHERE key IS NULL`,
    ],
  },
];

/**
 * The tables a store's row counts are taken over.
 *
 * Copy-forward compares these (slice 3), and the integrity queries report them. It is a
 * list rather than a scan of `sqlite_master` because a copy that gains a table is a
 * different shape of problem from a copy that loses rows, and the check has to name which.
 *
 * @type {string[]}
 */
const COUNTED_TABLES = [
  "store_info",
  "volumes",
  "chapters",
  "cast",
  "facts",
  "fact_characters",
  "facts_at_volume",
  "copy_provenance",
  "cast_merges",
  "challenges",
  "document_prose",
  "cast_presence",
  "cast_presence_match",
  "record_reopens",
];

// ─── Applying it ──────────────────────────────────────────────────────────────

/**
 * Read this file's schema version out of an open database, or null when it has none.
 *
 * @param {Object} db - An open handle.
 * @returns {number|null}
 */
function readSchemaVersion(db) {
  try {
    const row = db.prepare("SELECT value FROM store_info WHERE key = 'schema_version'").get();
    if (!row) return null;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    // No store_info table at all: an empty file, or a file that is not a reference store.
    return null;
  }
}

/**
 * Bring a database file up to this build's schema, and stamp what engine wrote it.
 *
 * Idempotent: opening a store that is already current runs no DDL. A store written by a
 * NEWER build is refused rather than half-read — a volume's file is committed with the
 * books, so a machine on an older client must say "I cannot read this" instead of querying
 * a shape it does not understand and reporting the difference as a finding.
 *
 * @param {Object} db - An open, writable handle.
 * @returns {{version: number, applied: number[], created: boolean}}
 */
function applySchema(db) {
  const hadTables = readSchemaVersion(db) !== null;
  const version = readSchemaVersion(db);
  if (version !== null && version > SCHEMA_VERSION) {
    throw new Error(
      `[reference-store] this database was written by schema version ${version}, and this ` +
        `build understands ${SCHEMA_VERSION}. Do not open it with an older client: the ` +
        "guards in this layer depend on the shape of the tables they query."
    );
  }
  const applied = [];
  for (const migration of MIGRATIONS) {
    if (version !== null && migration.version <= version) continue;
    db.exec("BEGIN");
    try {
      for (const statement of migration.up) db.exec(statement);
      db.prepare(
        "INSERT INTO store_info (key, value) VALUES ('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(migration.version));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    applied.push(migration.name);
  }

  const info = engineInfo();
  const put = db.prepare(
    "INSERT INTO store_info (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
  );
  put.run("engine", info.name);
  put.run("engine_note", info.note);
  put.run("schema_name", MIGRATIONS[MIGRATIONS.length - 1].name);
  return { version: SCHEMA_VERSION, applied, created: !hadTables };
}

/**
 * Whether a value is in one of the closed vocabularies.
 *
 * @param {string[]} list - The vocabulary.
 * @param {string} value
 * @returns {boolean}
 */
function isInVocabulary(list, value) {
  return typeof value === "string" && list.includes(value);
}

module.exports = {
  SCHEMA_VERSION,
  MIGRATIONS,
  COUNTED_TABLES,
  FACT_ASPECTS,
  FACT_STATUSES,
  SOURCE_STAGES,
  FACT_CHARACTER_ROLES,
  EVIDENCE_KINDS,
  EVIDENCE_MATCHES,
  EXTRACTION_SOURCE_STAGE,
  DOCUMENT_SOURCE_STAGE,
  REBUILD_SOURCE_STAGE,
  applySchema,
  readSchemaVersion,
  isInVocabulary,
};
