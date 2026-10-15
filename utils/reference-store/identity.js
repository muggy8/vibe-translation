/**
 * utils/reference-store/identity.js — the identity tables: an identity, and the roster names that
 * belong to it.
 *
 * The public face of `./identity/`. It holds no logic (AGENTS.md §3: the barrel is the public surface).
 *
 * WHY THIS EXISTS. The roster is the glossary's Characters table copied into `cast` — all 196 distinct
 * cast keys across the 17 real records are one of the 196 terms those tables publish — so a character the
 * glossary described under two names is **two roster entries by construction**, and the coverage guard
 * asks its question per entry. The fix the layer already had was `castAlias` → `cast_merges`: re-point
 * the duplicate's rows onto a survivor. Plan 06 §2.11 measured why that is the wrong door: a merge is the
 * one operation in this folder that can make a character's claims vanish from a query, it is irreversible
 * on a sealed record, and the narrowest-looking rule for reading the prose that states most of these
 * links produced **5 pairs, all 5 wrong**. The account owner's decision (§10.8) is a **relation instead
 * of a merge**: an identity, and the cast entries that reference it.
 *
 * WHAT THIS LAYER NEVER DOES. It does not merge, re-key, delete or re-point a cast entry. It does not
 * move a claim. It writes no `cast_merges` row. The two doors that decide where a claim lands —
 * `name-resolution.js` and `presence.js` — do not read these tables, and `test/test-identity-table-isolation.js`
 * is the guard that keeps that from drifting. A wrong link is therefore a wrong *group*, never a lost
 * sentence.
 *
 * @module utils/reference-store/identity
 */

require("../../types"); // JSDoc type definitions

const __shapes = require("./identity/shapes");
const __sources = require("./identity/sources");
const __file = require("./identity/file");
const __read = require("./identity/read");

module.exports = {
  ...__shapes,
  ...__sources,
  ...__file,
  ...__read,
};
