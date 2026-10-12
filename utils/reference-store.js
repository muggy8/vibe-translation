/**
 * utils/reference-store.js — the reference store: one database per volume, holding the
 * facts the glossary and the character-voice reference are rendered from.
 *
 * This is the public face of the layer. It holds no logic, only re-exports; the
 * implementation lives in `./reference-store/`, one concern per file, and this file is the
 * only name other modules should require (AGENTS.md §3: the barrel is the public surface).
 *
 * What it is for (the plan of record is `character-voice/plan/04-implementation-plan.md`,
 * the design is `03-database-backed-references.md`): the four cumulative reference
 * artifacts stop being documents a model re-types from volume to volume and become
 * **rendered output** from a store a model proposes rows into. The published files keep
 * their names, their folders and their shapes; what changes is that code writes them.
 *
 * The three rules that are not negotiable, and where each is enforced:
 *
 *   1. **A fact without verified evidence is refused at insert.** `reference-store/evidence.js`,
 *      reached from `facts.js`. No knob, no warning path.
 *   2. **Ownership is stamped by the harness, never by the caller.** `reference-store/open.js`
 *      freezes the write scope when the store is opened; `facts.js` writes it into the row
 *      and puts it in the `WHERE` clause of every update and delete.
 *   3. **A corrupt volume does not get to infect the next one.** `reference-store/copy-forward.js`
 *      runs the integrity queries before it copies, and a refusal is a HIGH post-mortem
 *      finding.
 *
 * Slices 2–5 added this layer WITHOUT giving it to any agent: there are no tool definitions
 * here. Slice 6 adds the pipeline's own door — `reference-store/pipeline-store.js`, which a
 * stage calls from its orchestration to file what it already produced and to run the audit — and
 * it is still not agent tool access: no agent reads, writes, or queries the store, and no prompt
 * mentions it. That is slice 7. The glossary half of the pipeline door is behind
 * `GLOSSARY_STORE_VALIDATORS` (off by default); the character-voice half is not behind any flag, because
 * that stage renders its artifacts out of the record. The store's own guards are behind neither.
 *
 * @module utils/reference-store
 */

require("../types"); // JSDoc type definitions

const __db = require("./reference-store/db");
const __paths = require("./reference-store/paths");
const __schema = require("./reference-store/schema");
const __refusals = require("./reference-store/refusals");
const __source = require("./reference-store/source-chapters");
const __evidence = require("./reference-store/evidence");
const __cast = require("./reference-store/cast");
const __facts = require("./reference-store/facts");
const __queries = require("./reference-store/queries");
const __integrity = require("./reference-store/integrity");
const __prose = require("./reference-store/document-prose");
const __presence = require("./reference-store/presence");
const __names = require("./reference-store/name-resolution");
const __copy = require("./reference-store/copy-forward");
const __glossary = require("./reference-store/glossary-adapter");
const __voice = require("./reference-store/voice-adapter");
const __extraction = require("./reference-store/extraction-adapter");
const __validation = require("./reference-store/validation");
const __pipeline = require("./reference-store/pipeline-store");
const __rebuild = require("./reference-store/rebuild");
const __povmap = require("./reference-store/pov-map");
const __drafting = require("./reference-store/drafting");
const __quarantine = require("./reference-store/quarantine");
const __reopen = require("./reference-store/reopen");

const __open = require("./reference-store/open");

module.exports = {
  ...__db,
  ...__paths,
  ...__schema,
  ...__refusals,
  ...__source,
  ...__evidence,
  ...__cast,
  ...__facts,
  ...__queries,
  ...__integrity,
  ...__prose,
  ...__presence,
  ...__names,
  ...__copy,
  ...__glossary,
  ...__voice,
  ...__extraction,
  ...__validation,
  ...__pipeline,
  ...__rebuild,
  ...__povmap,
  ...__drafting,
  ...__quarantine,
  ...__reopen,
  openReferenceStore: __open.openReferenceStore,
};
