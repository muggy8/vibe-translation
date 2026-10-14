/**
 * utils/prereqs/freeze.js — the other half of the prerequisite gate: a step may not **rewrite**
 * what a finished translation already consumed.
 *
 * `utils/prereqs.js` answers "may this step START?". This file answers the question that gate
 * cannot: "may this step REWRITE something a published translation was built from?". The account
 * owner's rule is one sentence — *if we are on the translation step, the pre-production artifacts
 * are frozen and are not expected to be changed, and that holds when a run is resumed* — and until
 * 2026-10-13 nothing enforced the second half of it. Measured against the code:
 *
 *   - `utils/series-run/skip.js`'s first line is `if (force || regeneratedAny) return false;`. It
 *     never asks whether anything downstream already consumed what it is about to rebuild;
 *   - `configs/shared/acceptance.js`'s `isSourceStale` compares exactly one checksum, the **source
 *     book's**. Nothing links a finished translation to the glossary it was translated from;
 *   - the cascade (`regeneratedAny`) runs inside one step only.
 *
 * So today: rewrite volume 5's glossary after volumes 1–8 are translated, resume, and the run
 * prints "already accepted, skipping" for eight translations built from a glossary that no longer
 * exists. Nothing says so.
 *
 * ## "Frozen" is read off the disk
 *
 * A volume is frozen when the `translate` step's own declared `required` per-volume artifacts are
 * in its folder. The names come from `specForStep("translate")` in `utils/artifacts.js` — never a
 * second list written here. That is the mistake gotcha 141 is about: two lists of one artifact
 * become two opinions about whether a volume is finished. A resumed run answers the same question a
 * fresh run does, because the answer is a folder listing and not a memory of the current process.
 *
 * ## The freeze is on REWRITING, not on looking
 *
 * The prerequisite gate makes `discover` and `extract` run before **every** step. If the freeze
 * blocked them outright, a resumed run sitting in the translation stage could not run anything at
 * all. So the question is never "is this step allowed to run?" but **"would this act actually
 * rewrite it?"** — and that question is answered by the same conditions `utils/series-run/skip.js`
 * already uses to cancel its own skip (`force`, the cascade, a changed source fingerprint, a failing
 * acceptance state, a missing output). `utils/series-run/skip.js` now computes that decision in
 * `skipDecisionFor` and this file reads the same decision; there is no second copy of the rule.
 *
 * A frozen volume whose skip stands is **not** a refusal. `extract` on a warm cache verifies each
 * volume's bundle and rewrites nothing; `discover` reuses the plan of record; `consistency-audit`
 * skips while its provenance sidecar still fingerprints the four artifacts. All three must keep
 * working on a frozen series — the offline pipeline loop's second pass, which must make zero model
 * calls, is the test that proves this half got it right (gotcha 130: a gate that fires on
 * legitimate output is worse than no gate).
 *
 * ## The one cancellation that is not a rewrite
 *
 * `missing-output` — the artifact this door would write is not there. Filling a hole in a
 * half-built series is not overwriting something a translation consumed, and refusing it would make
 * an inconsistent series unrepairable. It is the only skip-cancelling condition that does not count
 * as a rewrite, and the reason is written beside it in the door table rather than left as an
 * absence.
 *
 * ## There is no switch. There is a recorded act.
 *
 * AGENTS.md §4 rule 3. No flag, no environment variable, no ledger entry and no run policy reaches
 * this gate: `--force`, `--allow-fail`, `ON_TASK_ERROR=continue` and `ON_VOLUME_ERROR=skip` are not
 * inputs to the question, and a refusal is a **structural** error so none of them can walk past it.
 * The only way through is `release-translation.js` — the shape `reopen-volume.js` established
 * (gotcha 113): a typed reason (refused under 20 characters, the same floor as `reopen`), a row in
 * the run's own records naming the volumes whose translation it invalidates and the artifact it is
 * about to rewrite, and nothing done to a translation: it does not delete, edit, mark or schedule
 * anything in a translation folder. A release is **standing** — it does not expire — because the
 * translation artifacts stay on disk, so a release that expired would make the volume impossible to
 * rebuild. It is therefore named in the resume triage and the delivery report for as long as it
 * exists.
 *
 * ## Where the table lives, and why it cannot be edited from a process
 *
 * This file is in `utils/prereqs/`, which `utils/patches/rules.js`'s `constraint-tables` pattern
 * already bans (`/^utils\/(?:…|prereqs)(?:\.js|\/)/` matches the folder as well as the file), for
 * the reason that ban already gives for the prerequisite table: a role that can edit the rule that
 * stops it is not being stopped. The door table is `Object.freeze`d on top of that, because a table
 * any importing module can reassign is a dial.
 *
 * ## Where the code lives
 *
 * The code is in `utils/prereqs/freeze/`, one kind of job per file: `doors.js` (the door table, the
 * manual-door → owning-stage map, `NOT_A_REWRITE` and the two lookups that read them),
 * `declared-artifacts.js` (the artifact names this gate reasons about, queried out of
 * `utils/artifacts.js` rather than written a second time), `frozen-state.js` (which volumes this run
 * touches, and whether a translation already stands on top of each), `releases.js` (the recorded act
 * that is the only way past, with its reason floor and its record file), `wording.js` (`CANCEL_WORDS`
 * and the sentence for one frozen volume) and `gate.js` (the decision itself). This file is the public
 * surface and the only thing another module should require; every table stays inside this folder, so
 * splitting the file moves no table out of the ban (AGENTS.md §3).
 *
 * @module utils/prereqs/freeze
 */

const doors = require("./freeze/doors");
const declaredArtifacts = require("./freeze/declared-artifacts");
const frozenState = require("./freeze/frozen-state");
const releases = require("./freeze/releases");
const wording = require("./freeze/wording");
const gate = require("./freeze/gate");

// The public surface, unchanged from the single file.
module.exports = {
  FREEZE_DOORS: doors.FREEZE_DOORS,
  DOOR_OWNER: doors.DOOR_OWNER,
  NOT_A_REWRITE: doors.NOT_A_REWRITE,
  MIN_RELEASE_REASON_CHARS: releases.MIN_RELEASE_REASON_CHARS,
  RELEASE_RECORD_FILE: releases.RELEASE_RECORD_FILE,
  RELEASE_RECORD_SCHEMA: releases.RELEASE_RECORD_SCHEMA,
  freezeDoorRow: doors.freezeDoorRow,
  frozenDoors: doors.frozenDoors,
  requiredTranslationArtifacts: declaredArtifacts.requiredTranslationArtifacts,
  readFrozenState: frozenState.readFrozenState,
  readFreezeScope: frozenState.readFreezeScope,
  doorArtifacts: declaredArtifacts.doorArtifacts,
  releaseRecordPath: releases.releaseRecordPath,
  readTranslationReleases: releases.readTranslationReleases,
  releaseCovering: releases.releaseCovering,
  recordTranslationRelease: releases.recordTranslationRelease,
  evaluateFreeze: gate.evaluateFreeze,
  freezeRefusal: gate.freezeRefusal,
  assertDoorAllowed: gate.assertDoorAllowed,
};
