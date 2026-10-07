/**
 * utils/delivery-verify.js — did the intervention help the book?
 *
 * This is the acceptance test for an intervention (plan §5, Phase 4). The delivery manager may
 * wipe a volume's accepted output and re-run a step; the question it is NOT allowed to ask is
 * "did the error go away?". That question is answerable by removing the thing that reported the
 * error, which is the exact failure this whole layer exists to prevent (gotcha 70: volume 15's
 * gate was correctly refusing a glossary that had GROWN, and the cheapest ticket answer was the
 * setting under which 457 terms once vanished). So the question here is the other one:
 *
 *   **Is the deliverable better, the same, or worse than it was before you touched it?**
 *
 * What that means concretely, and why each half is in the list:
 *
 *   1. **The book.** `translation-report.json` is the pipeline's own sign-off on what it
 *      published — per chapter, whether it is PUBLISHED (verified), UNVERIFIED, MISSING, or
 *      empty in the source, with the verification score and the two deterministic drift counts.
 *      It is read through `utils/translation-report.js`, the module that writes it, so the
 *      triage and this comparison cannot describe one report two different ways.
 *   2. **The reference layer.** A glossary intervention cannot move the publish report at all —
 *      the translation stage has not run yet — so the deliverable of THAT step is its own
 *      artifact: how many terms the glossary carries, how many characters the voice reference
 *      holds sections for, which style categories survive, how many chapters the wiki hands off
 *      to the translator. These are the same invariants the pipeline's own carry-forward gates
 *      protect (gotcha 64/65/68), measured here from the outside.
 *   3. **The step's own output.** How many volumes hold what that step always leaves.
 *
 * Two rules decide the verdict, and they are the whole point of the module:
 *
 *   - **A regression vetoes an improvement.** `Add the old spelling back as a second row`
 *     (the option `utils/tickets.js` deliberately does NOT ban) removes the finding and shrinks
 *     the glossary's carried-forward terminology. The finding disappearing is not evidence; the
 *     glossary getting smaller is. So one damage signal outranks any number of improvements,
 *     and the answer is `worse`.
 *   - **A gate's verdict is not a deliverable signal.** PASS/FAIL reports, validation reports
 *     and quarantine evidence are excluded: switching a check off moves them for free. Only
 *     facts about the CONTENT the pipeline produced are measured. This is the difference
 *     between "the complaint stopped" and "the book got better", and it is the reason a
 *     weakened guard cannot be accepted as a fix.
 *
 * What it never does: it does not judge whether an artifact is GOOD (that is the scored gates'
 * job — `PASSING_SCORE`, the rubrics, the acceptance window; gotcha 67), and it does not decide
 * what to do about a regression. It answers one question, in one place, so that "did it help?"
 * has one answer in this codebase: act mode's ledger entry and a ticket's closure both come
 * from `compareDeliverable`.
 *
 * Honesty rules, inherited from the rest of the pipeline:
 *   - **A file that could not be read is not a file with nothing in it.** An unreadable artifact
 *     makes its signal NOT COMPARABLE and says so, exactly like `fingerprintFiles` records an
 *     unreadable file as `missing` so a read error cannot masquerade as "nothing changed".
 *     Treating a read failure as zero terms would report a permissions problem as a loss of the
 *     glossary — the direction of error that gets good work deleted.
 *   - **A signal whose denominator changed is not a signal.** The median verification score is
 *     only compared when both sides graded the same number of chapters; a book that gained a
 *     chapter is a different book, and averaging across it is not a measurement.
 *
 * The code lives in utils/delivery-verify/: signals.js (what is measured, as
 * data), read.js (reading a file for measurement), book.js (the publish report),
 * reference.js (the reference layer, the per-step counts, and the snapshot),
 * compare.js (the verdict and the three ways it is read). This file is the public
 * surface, and the two shapes every consumer's JSDoc names.
 *
 * @module utils/delivery-verify
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One measurement of the deliverable.
 *
 * @typedef {Object} DeliverableSnapshot
 * @property {number} schema
 * @property {string} measuredAt
 * @property {string} seriesDir
 * @property {Object|null} book - The publish report's roll-up (null when there is no report yet).
 * @property {Object} reference - Per cumulative step: what its artifacts actually hold.
 * @property {Object} steps - Per pipeline step: how many volumes have its output.
 * @property {string[]} notes - Measurement honesty: what could not be read, and what was skipped.
 */

/**
 * One signal's movement between two snapshots.
 *
 * @typedef {Object} SignalMovement
 * @property {string} name
 * @property {string} label - What the signal is, in the words a human reads.
 * @property {("better"|"worse"|"none")} direction
 * @property {boolean} veto - Whether a `worse` movement here decides the outcome.
 * @property {boolean} comparable - False when the two sides cannot be compared (and `why` says why).
 * @property {number|null} from
 * @property {number|null} to
 * @property {string} why - What the signal means, and why it is or is not comparable.
 */

const signals = require("./delivery-verify/signals");
const read = require("./delivery-verify/read");
const book = require("./delivery-verify/book");
const reference = require("./delivery-verify/reference");
const compare = require("./delivery-verify/compare");

// The public surface, unchanged from the single file.
module.exports = {
  DELIVERABLE_SIGNALS: signals.DELIVERABLE_SIGNALS,
  REFERENCE_ARTIFACTS: signals.REFERENCE_ARTIFACTS,
  READ_CAP_BYTES: read.READ_CAP_BYTES,
  measureDeliverable: reference.measureDeliverable,
  measureBook: book.measureBook,
  compareDeliverable: compare.compareDeliverable,
  describeComparison: compare.describeComparison,
  accountOf: compare.accountOf,
  summarizeSnapshot: compare.summarizeSnapshot,
  closureFromComparison: compare.closureFromComparison,
};
