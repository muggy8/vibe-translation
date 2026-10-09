# The delivery layer — running a step, assessing it, and recovering from a run that stopped

docs/delivery-layer.md The step runner, the deterministic post-mortem, the ledger, the tickets, the two support teams, the patch channel, the resume triage, the acceptance test, the run lock, and the autopilot.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

### 3.6 Step-by-step running and the post-mortem (`index.js`, `utils/postmortem.js`)

`npx gulp` runs all nine steps **inside one Node process**. `npm run pipeline` runs
them **one step per process**, and assesses each step before starting the next. Both
halves matter, and they are separate features: the runner (`index.js`) and the
assessment (`utils/postmortem.js` + `utils/artifacts.js`). Either can be used without
the other — `utils/postmortem.js` is a module, and `npx gulp` still works unchanged.

**Why a process per step.** Node caches a module the first time it is required, and
`gulpfile.js` requires all ten task modules at the top of the file. A fix written to
disk during a run is therefore *not* the code the rest of the run executes — and
"evict it from the cache and re-require" would leave the new module coexisting with
every old reference already captured (gulpfile's destructured `const { glossary }`,
the re-export chains between `translate.js` / `verify-translate.js` /
`utils/translate.js`, and any agent session mid-turn), i.e. a volume half-built by
old code and half by new. A fresh process is the honest reload boundary, and it is
**cheap**: the idempotent skip-checks make a re-run cost almost nothing, and a
process start is not a model container switch (`hooks/.model-switch-state` makes a
repeat switch a no-op, gotcha 22). The granularity given up is resuming mid-volume;
per-chapter state already makes re-running a volume cheap.

**Why assess before the next step.** With `ON_TASK_ERROR=continue`, a failed step
leaves the remaining steps to run on a foundation that was never built. Running the
steps in order with an assessment between them means a broken glossary is found
before `character-voice` builds on it, and long before the translation stage has paid
for it.

**The post-mortem is the tier that can run for free.** 17 volumes × 9 steps is a lot
of assessment, so it is split: **tier 1 is deterministic** (no model call, no
network) and runs on every volume of every step; **tier 2 is a model call**, and does
not exist yet. Tier 1 exists because of what the real failures in this project look
like — 457 glossary terms vanished with no error, volume 06 shipped 411 of volume
05's 769 terms and was **accepted at 78/100**, volume 04 has a `glossary.md` and
nothing else, a 164-character planning sentence became the series' character voice
reference, a feedback pass made 46 tool calls and wrote nothing and the loop paid
8.4M tokens to re-audit an unchanged document. **Not one of those is a crash.** A
runner that only reacts to exceptions catches none of them; a check that asks "did
this step leave the files this step always leaves, in the shape they always have?"
catches most of them, for free.

**Findings, not exceptions.** `runPostMortem` returns data (`HIGH` / `MEDIUM` /
`LOW`, each with a stable `kind`), and `index.js` decides what to do with it.
`POSTMORTEM_FAIL_ON` (default `high`) sets which levels fail the run; `never` reports
everything and exits 0 — use it while the check is new and you are learning which
findings are real. Reports go to `.postmortem/<step>.md` (for a human) and
`.postmortem/<step>.json` (for whatever reads them next).

**One finding reads the QA loop's own channel rather than its output.** Each volume's
rolling-state file now carries a tally: how many grades the loop asked for, and how many
came back in a shape nothing could read. `grade-failures` is HIGH when every grade was
unusable and MEDIUM when some were. The reason it is a finding and not a log line is that
the alternative evidence for that failure is indistinguishable from success: an
unparseable grade is refused, the loop keeps iterating, and the run ends having spent
hours and accepted nothing — with no file that says so. The tally is absolute (it carries
across runs of the same volume, and is re-seeded from the previous state at the start of a
volume), it is written on every save so the several saves one iteration makes cannot
double-count it, and wiping a volume deletes the state file and with it the tally, which
is the correct reset. See `newGradeTally` / `tallyGrade` in `configs/shared/acceptance.js`.

**What it deliberately does not do.** It does not judge whether an artifact is
*good* — that is the scored gates' job (`PASSING_SCORE`, the rubrics, the acceptance
window). Putting a second, weaker grader next to the real one creates two answers to
the same question. And it does not fix anything: no diagnosis agent, no patching, no
retry loop. Assessment is deterministic, free, and safe on every step of every run;
deciding to rewrite code is none of those, and the two stay separate.

**The run ledger (`utils/ledger.js`) — the memory the delivery stage needs.** Every
assessed step appends one entry to `.postmortem/ledger.json`: what the step left behind
(counts + the distinct finding kinds), and later what was decided about it and what
happened after. This exists because the pipeline remembers *artifacts* and has never
remembered a *decision*, and a runner with the authority to re-run steps fails in a
predictable way without it: **spinning** — a finding appears, the step is re-run, the
same finding appears again, it is re-run again, and a 12-hour run ends where it started.
Volume 15 of the live series is exactly that shape (gotcha 68): re-running a deterministic
gate produces the identical quarantine every time, because the finding was never about
the data.

The rule the ledger enforces is `TRANSLATE_QA_RETRY_BUDGET` lifted to run level: **the
same action against the same finding, ending `unchanged` or `worse` twice in one run, is
refused** — and the refusal names what to do instead (open a ticket for the diagnostics
stage). Three properties keep it from becoming the guard that gets disabled: only
*repetition* is blocked (a different action, or a different volume, is a new attempt);
an attempt that `improved` is not evidence against anything; and the count is scoped to
one run, so after a real fix the same action is legitimate again. `recurringFindings`
reports, for free, the finding classes that survived an earlier run — and `index.js`
then declines to repeat the advice "just re-run, it's cheap" when the ledger shows a
re-run has already not cleared it. A ledger that cannot be read is treated as spinning
rather than as empty: refusing an action is recoverable, spinning is not.

**Tickets (`utils/tickets.js`) — the only thing the manager can say to a team that can see the
code.** When re-running stops working, the manager opens a ticket. A ticket is a question with its
evidence attached: the step, the finding `kind`, the files it looked at and what it saw in them,
what it already tried (copied out of the ledger, so "this is the third time" is a query rather than
a claim), what it ruled out, and the question itself. `validateTicketShape` refuses anything else
and says what to write instead — a command ("Disable the guard for this volume"), a demanded result
("Make volume 15 pass", "so that it passes", "get rid of the finding"), a request for something on
the banned list, or a summary with no question in it.

**Why the shape rule exists, and why it sits on the option generator too.** Volume 15 of the live
series (gotcha 68) is the whole argument in one case: the carry-forward gate quarantined a glossary
that had *grown* from 445 terms to 460, and the gate's own message blamed a reply-budget cut-off. A
ticket that said "make volume 15 pass" would have been answered — the cheapest answer available is
always the one that removes the *finding* rather than the *fault*, and here that answer is
`GLOSSARY_CARRY_FORWARD_GUARD=false`, which is the setting under which 457 terms once vanished with
no error at all. So the constraint cannot be "the manager should choose wisely": a manager given a
menu picks the cheap item on it. `attachOptions` therefore runs `optionIsBanned` on the diagnostics
team's reply, and refuses options that would remove a finding without changing the deliverable —
disabling a carry-forward guard, `--allow-fail` / `--allow-no-glossary`, lowering `PASSING_SCORE` or
any acceptance threshold, deleting `.rejected` files or reports, editing `hooks/`, declaring an
artifact expectation away, flipping an `ON_*` run policy to `skip`, or disabling the ledger. Each
refusal names the escalation: if diagnostics genuinely believes one of these is correct, it says so
in prose to the **account owner**, the only role that may un-check a guard.

Two things this deliberately does not pretend. The demand check is a **shape** check, not a mind
reader: it catches the forms a demand actually takes, and a ticket that slips through is still
answerable by a diagnostics team with its own list. And the filter is narrower than "is this a good
idea" — `Add the old spelling back as a second row` is NOT banned (it manufactures a duplicate,
which is a judgment about the deliverable, not a guard being removed), and it survives the filter
with `verify: "the finding disappears"` as its only stated check. That is exactly the option the
before/after comparison of the deliverable exists to reject, and `test/test-tickets.js` pins that
split rather than smoothing it over. Refused options stay on the ticket with their reason, because a
dropped option looks like it was never thought of.

**Uncapped turns, and what replaces the cap (`utils/context.js`).** The diagnostics team and the dev team have **no step limit**. That is not a loosening for its own sake: the failure this layer kept producing was a turn that ran out of budget in the middle of work it had already paid for. The diagnosis turn that started this change ran 702 seconds, 7.2M prompt tokens and 73 tool calls, re-opened one file twelve times, hit its cap at step 39, and answered with **zero characters** — while the answer was already written down in this file (gotcha 68). A step cap cannot tell "still working" from "spinning", and it punishes the first while permitting the second.

So the cap is gone and three other things stand in its place, and each one is a different failure mode:

- **A repetition detector.** A call counts as a repeat only when the tool name, the arguments AND the answer are identical — so an errored call is never a repeat of an answered one, but the same error repeated up to `AGENT_REPEAT_LIMIT` (3) IS a spin. On a hit the harness logs a greppable WARNING, aborts the turn, and throws an error that names the call and the knob. It watches the tool's RAW answer, before the pressure line is added, or every call would look like a repeat of itself.
- **A loose time ceiling** (`AGENT_TURN_MAX_MS`, default 2 h; `0` removes it deliberately). A wall, not a budget — the same reasoning as `AUTOPILOT_MAX_ITERATIONS`.
- **The idle deadline** (`AI_CALL_DEADLINE_MS`), which is already the harness's only per-call wall-clock bound (gotcha 26).

What makes uncapped affordable is that the turn does not have to hold everything in its own head. When the conversation reaches 70% of `AI_CONTEXT_WINDOW` the harness says so **inside every tool answer** ("working window: 11,401 / 16,000 tokens (71%) — getting full. Offload what you no longer need with `manage_context(...)` BEFORE your next read."), and at 90% it moves the old read answers to disk itself. The turn then continues as the SAME conversation in a new chunk — `agent.maxSteps` is the size of a chunk, not of the turn, and there is no limit on chunks. What was moved is not lost: the conversation keeps one map block per offload naming every file the turn looked at, plus a one-line pointer where each moved answer used to be, and `recall_memory("the phrase you are looking for")` brings the text back verbatim from `<run dir>/agent-<name>/turn-NNN-memory/`.

Two things about that are load-bearing and easy to get wrong. **The pressure line is the real mechanism, not the tools.** The paper this design came from measured that a model calls tools like these about *zero* times unless it is told to; a tool the agent is never prompted to reach for is a tool that does not exist. **And compaction is limited to this layer on purpose.** A pipeline stage agent's whole job is to keep the artifact it is amending and the text it is amending in front of it at the same time; handing it `manage_context` would let it set aside the very text it is required to preserve, which is gotcha 64 rebuilt out of good intentions. `CONTEXT_MANAGED_ROLES` is the opt-in list, a non-managed handle runs exactly one chunk, and `test/prompt-audit.js`'s `stage-context-offload` rule fails the offline pipeline if a stage request ever advertises either memory tool.

What is never moved: a mutating tool's result (the agent must be able to see what it wrote), an error or a refusal (that is the answer the agent has to react to), the most recent `CONTEXT_KEEP_RECENT_TOKENS`, and user or assistant messages — only old READ answers move, and the CALL stays in the transcript, so `crossCheckReads` can still prove the turn read what its answer cites. If nothing can be moved, the harness says so honestly ("this does not fit in one turn") rather than falling back to a summary — the honest failure is the one the account owner can act on.

The record of such a turn is its **shape**, not a limit: `turnShapeOf(result)` (utils/agents.js) stores `{chunks, toolCalls, offloads, offloadedTokens, compactions, endedAs}` on the diagnosis record and the patch record, and `endedAs` keeps the harness's own word for the ending so a record cannot soften "stopped" into "finished". `compactions` is counted and logged, because a turn that compacted is a turn that lost something.

**The diagnostics team (`utils/diagnostics.js`, `diagnose.js`) — the role that CAN see the code.** A ticket is
only useful if somebody on the other end can open the files. That role is deliberately the mirror image of the
manager's: it reads the code, the prompts and the `.logs/` transcripts — the three things the manager may never
see — and it may not write anywhere at all. `readOnlyFsTools` hands it only `readFile` / `listFiles` / `grep`, and
the composed approve gate denies every mutating call and records each refusal, so the guarantee has two layers
and a write attempt is reported whichever one stopped it (gotcha 74). It answers in a fixed shape — cause, options
(each with what it touches, its cost, its risk and how the manager checks it), a recommendation, questions back to
the manager, and an `ownerNote` — and `validateDiagnosisShape` is fail-closed on that shape the way
`parseAcceptanceReply` is fail-closed on a grade. Three rules in it are load-bearing:

- **The options go through the same filter, on the way in.** `diagnoseTicket` reaches the ticket only through
  `recordDiagnosis`, which runs `attachOptions` internally, so there is no path from a model reply to a ticket that
  skips the banned-option filter (gotcha 70). When every offered option was refused, the ticket stays `answered`
  and gains a `noUsableOptions` flag, and `tickets.md` says plainly that the decision now belongs to the account
  owner — because the team's actual belief, if it is "this guard is wrong", belongs in `ownerNote`, which is prose
  for a human and never an option.
- **A diagnosis shows its reading.** The turn's real tool calls are recorded and cross-checked against the files
  its answer cites: a file named as evidence that the turn never opened is reported as `citedWithoutReading`, and
  the ticket's evidence is hashed before and after the turn, so "read-only" is checked against the disk rather than
  asserted. The check is honest in both directions — a `grep` over a folder read everything in it, and a call that
  errored proved nothing.
- **It shows its reading, and it is not capped.** The turn's real tool calls are recorded and cross-checked
  against the files its answer cites: a file named as evidence that the turn never opened is reported as
  `citedWithoutReading`, and the ticket's evidence is hashed before and after the turn, so "read-only" is checked
  against the disk rather than asserted. The check is honest in both directions — a `grep` over a folder read
  everything in it, and a call that errored proved nothing — and a file the turn got back with `recall_memory`
  counts as read, because it read it earlier and the harness kept the text. There is no step cap and no token
  budget: what bounds the turn is the repetition detector, the loose turn clock, and the fact that its old reads
  go to disk instead of out of the window (see "Uncapped turns" above and gotcha 78). One diagnosis per ticket
  unless somebody asks for a second with `--reask`.

What it may not do is decide. It offers options and says which it recommends; the manager chooses among the ones
the filter allowed, and only the account owner may un-check a guard.

**The dev team (`utils/devteam.js`, `fix.js`) — the role that may change the code, and the reason it is last.** A
diagnosis that says "the relevance test compares the whole cell instead of the aliases inside it" is useless unless
somebody can change that line. This is that somebody, and the analogy the account owner chose (2026-10-05) is the
shape of it: the manager is a **client** with a support contract, and diagnostics plus this team are the **provider**
— the provider fixes its own software, tells the client what changed and what it might break, asks clarifying questions
back, and the client's whole authority is to accept or refuse. So the manager never sees the code and never applies a
change: it summons this team **only by choosing an offered option marked `requiresCodeChange`**, never by describing a
fix in prose, and its two verbs on a proposal are `--accept-patch` and `--reject-patch`, both refused in report mode.

Four rules make that survivable, and all four are enforced in code rather than in a prompt:

- **A patch may not edit the rules that judge it.** `BANNED_PATCH_PATHS` refuses the guard tables
  (`utils/{tickets,resume,delivery-verify,ledger,runlock,patches}.js`), the tests that pin them, `hooks/`, `.env`, the
  machine state, the corpus and anything outside `ai-client/`. It is enforced **twice** — the file tools refuse the
  write during the turn, and the proposal is refused again when it names such a path — and each refusal names the rule
  it hit, because "not allowed" is not information and a team that cannot tell which rule it tripped cannot write a
  usable second proposal. The one thing the table cannot catch is a patch that leaves `package.json` alone and quietly
  removes a suite from the `npm test` chain, so `testChainIsIntact` compares the chain read before the turn with the
  chain read after it: removing a suite is a refusal, adding one is a warning.
- **The proposal carries a claim; the machine produces the numbers.** The team answers in
  `{files, summary, why, couldBreak, expected, verify}` — and `expected` must name the deliverable signals
  `utils/delivery-verify.js` actually measures, because a fix argued in units nobody measures cannot be checked. The
  real before/after comes from act mode's comparison when the accepted patch is cascaded, not from the team's own
  report. What the manager judges is a **proposal** (what changed, why, what it could break, what it expects to move,
  how to check it), never a diff — it is the role that cannot read code.
- **A patch shows its changes.** The harness gives an agent no shell, so the team cannot run `npm test` and the
  proposal must not claim it did; the CLI runs the pinned checks itself and records what actually returned, including
  the checks that never ran. And the working tree inside `ai-client/` is fingerprinted before and after the turn: a
  file that changed without being declared is a **refusal**, and a file declared without changing is a warning. That is
  the same "show your reading" rule the diagnostics team is held to (gotcha 74), applied to writing.
- **A patch is live code the moment it lands, so an unjudged patch stops the manager.** `fix.js` commits to `main`
  (the branch idea was dropped 2026-10-05: one team at a time, and a patch may not land while a run is in progress —
  gotcha 66's rule that a carry-forward gate cannot tell a code change from a data loss). While a patch sits at
  `proposed` or `verified` it is in the tree and unjudged, so act mode refuses the whole plan rather than running a
  measurement it cannot attribute. Accepting is what makes the commit happen, and the manager's wipe-and-cascade is
  what makes the fix take effect (gotcha 66: a plain re-run skips everything because the skip checks do not know the
  code changed). Rejecting reverts the tracked files the patch declared and **names** the files it created instead of
  deleting them — deleting is Tier C.

What it deliberately does not have: a branch, a token budget, a step cap, a knob for the banned-path table, or the
ability to delete. The turn is uncapped for the same reason the diagnosis turn is — a dev turn reads code before it
writes it, and a cap punished exactly that (gotcha 78) — with the repetition detector, the loose turn clock and the
disk offload standing where the cap used to. What bounds the cost is the fact that a ticket gets one team at a time.
See docs/delivery-layer.md and gotcha 75.

**The resume triage (`utils/resume.js`) — reading a half-built run without reading the code.** The
delivery-manager design gives an agent authority over a run while it never sees the code. The first
thing it needs is not intelligence, it is a **reading of the state**: which step stopped, at which
volume, and whether the answer is a re-run at all. `npm run delivery` produces that as a report,
from five sources that already exist — the plan of record, what each volume folder actually holds,
the nine `runPostMortem` assessments, the ledger, and `translation-report.json` (the deliverable
itself). It costs nothing and calls no model, which is what makes it safe to run before every
decision.

Four rules in it are load-bearing, and each one is a mistake this module actually made on the live
17-volume series:

- **Evidence is not damage.** A `.rejected` file says a gate fired at some point. It does not say
  the work is unfinished. The first version chose volume 02 as the resume point because a
  `glossary.md.rejected` was lying there — and volume 02's glossary is complete, so the proposal
  was "throw away thirteen volumes of accepted work to deal with a leftover file". Now the HIGH
  findings split into **damage** (work missing: decides the resume point) and **evidence** (a gate
  refused something: reported, never acted on), and a step whose outputs are complete but whose
  evidence survives gets verdict `evidence` — *read it before running anything*.
- **A quarantine belongs to the artifact it names, not to every step that declares the pattern.**
  `utils/artifacts.js` declares one pattern for all three cumulative gates, so pattern-matching
  attributes a `character-voice.md.rejected` to glossary — which then justifies "glossary's own
  gate removed this file" for a volume whose glossary gate never fired.
- **A declared name is a template.** `jump-in-wiki-validation-{installment}.md` compared against a
  directory listing is never equal, so a finished step reads as missing and a wipe list gets a
  literal `{installment}` in it, which deletes nothing.
- **When the gate removed the output, a re-run is the spin.** Volume 15 is missing its glossary
  *and* holds `glossary.md.rejected` in the same folder: the gate took the file and nothing
  replaced it. Re-running the step rebuilds the file and runs the same deterministic gate over it,
  which produces the identical quarantine. So that shape — and a FAIL audit verdict, and a finding
  the ledger says already survived a recorded run — all become **`open-ticket`**, not a re-run. The
  plan says out loud that re-running reproduces the quarantine, because a refusal that does not
  name the spin just looks like caution.
- **An attempt that did not help is read off the ledger, because the disk cannot say it.** A step
  killed part-way through its work leaves a folder that looks exactly like "the work was never
  done", and a step that ran to the end and was refused by its own gate leaves a quarantine. Only
  the ledger distinguishes "nothing has been tried yet" from "something was tried, it cost a real
  step's worth of model calls, and the deliverable did not move" — so `unhelpfulInterventions`
  reads this run's `intervention` entries for the resume step that ended `unchanged` or `worse`,
  and the plan becomes `open-ticket` (`attempt-did-not-help`) rather than a second attempt. An
  attempt that `improved` is not evidence against anything, and a different step's failed attempt
  does not spend this one's — the same per-step rule the budget uses. This is what lets the
  autopilot keep going after a failure without turning that into paying for the same step twice
  (gotcha 90).

`DELIVERY_ACTIONS` is the closed menu the plan may name, and `countsAsIntervention` on each entry is
where the account owner's decision of 2026-10-05 lives: **picking up unfinished work is not an
intervention** (`resume-here`, `re-run-step`, `re-translate-volume`, `open-ticket`, `answer-question` are
free), while
wiping output that exists, `--force`-ing accepted output, and re-auditing are (`wipe-and-cascade`,
`re-run-force`, `re-audit` count against `DELIVERY_MAX_INTERVENTIONS` — **per step**, the account
owner's decision of 2026-10-06: a run with nine steps is nine problems, and a global cap spends
glossary's attempts on the wiki). `planResume` reads the ledger's `intervention` entries for the
newest recorded run, groups them by step, and a step that has spent its budget becomes
`open-ticket` — the honest reading of "I have run out of moves on this step" is that it needs
somebody who can see the code. Tier C is not a limit the
manager can reach — editing code or prompts, deleting anything, `--allow-fail` /
`--allow-no-glossary`, renaming a volume folder, touching `old (do not touch)/` or a staged book, or
running intake — and each Tier C entry carries the `why` so a refusal can name what it refused.
`delivery.js` re-checks every action the plan names against the menu and exits 2 on one it does not
find, so the menu cannot be widened by a bug in the triage.

**What it deliberately does not own.** Intake. `discover` keeps its own agent, its own guards and
its own questions (which files are volumes, in what order, what the series is called), and the open
questions in `translation-plan.md` are intake-and-account-owner decisions. When there is no plan of
record the triage reports `blocked`, says the intake questions are not its own, and never proposes
`run-intake` — which is Tier C. What the manager owns is **resumption**.

**Report mode is the default; act mode is what it earns.** `DELIVERY_MODE=report` writes a proposal and
executes nothing, and that ordering is the point: the manager earns the right to act by writing a report
that is demonstrably right about a real run. `--mode=act` now exists, and what it does is narrow:

- It executes only a plan whose resume point is actually executable. If the plan's own answer for that
  step is a ticket or a block, **nothing runs** — the steps listed after the resume point are written on
  the assumption that the resume point was repaired, and running them anyway spends a real run's worth of
  model calls on a foundation this manager could not fix.
- Each step is gated three times before anything is touched: the closed action menu (a Tier C move is
  refused **by name**, at execution time, not only in the proposal), the per-step intervention budget, and
  the anti-spin ledger. A refusal wipes nothing — a refusal that deleted first would be indistinguishable
  from a fix.
- An allowed action wipes the step's declared outputs (never `.rejected` evidence), spawns the real step
  runner in its own process, re-reads the state, and judges the outcome by comparing the deliverable
  before and after. `improved` / `unchanged` / `worse` is recorded in the ledger under the **newest
  recorded run**, not a fresh run id per invocation — otherwise the anti-spin gate can never see the whole
  story, and the count only resets when a genuinely new `npm run pipeline` run makes its own id.
- The plan is a **sequence**: the first refusal or failed step stops it, because every later step is
  written on the assumption that the earlier one was repaired.
- It refuses to start while a pipeline run holds the run lock, and refuses `--no-write` together with
  `--mode=act` (exit 2): a rehearsal that records its interventions would poison the very ledger that
  stops a spin. There is deliberately no `--dry-run` passthrough in act mode for the same reason.
- Exit codes: 0 completed, 1 stopped short (a gate refused, or a step did not finish), 2 the request
  itself was refused (an action not on the menu, a contradictory flag).

**The acceptance test (`utils/delivery-verify.js`) — what an intervention is judged against.** Act mode's
verdict is not "did the error go away". That question is answerable by removing the thing that reported
the error, which is the failure `utils/tickets.js` exists to refuse (gotcha 70). So every action is
measured twice — before anything is deleted, and after the step finishes — and the answer is whether the
**deliverable** moved: the publish report's roll-up (PUBLISHED / UNVERIFIED / MISSING, the median
verification score, the cross-chapter HIGH findings, the rendering-variant conflicts, the open glossary
disputes), what the cumulative artifacts actually hold (term rows, character sections, style categories,
the chapter handoff), and how many volumes hold each step's declared output. Three rules make it a check
rather than a scoreboard:

- **A regression vetoes an improvement.** `Add the old spelling back as a second row` is the option the
  ticket filter deliberately does *not* ban — it removes the finding and shrinks the carried-forward
  terminology, and the thing that rejects it is this comparison, not the filter. One damaged invariant
  makes the whole attempt `worse`, whatever else improved.
- **A gate's verdict is not a signal.** `consistency-report.md`'s PASS/FAIL, the validation reports and
  the quarantine counts are excluded, because disabling a check moves all of them for free. Only facts
  about the content the pipeline produced are measured. That is the difference between "the complaint
  stopped" and "the book got better", and it is why a weakened guard cannot be accepted as a fix.
- **An incomplete measurement is reported, not guessed.** A file that could not be read makes that step's
  content signals *not comparable* — never zero (the `fingerprintFiles` rule again: a read error must not
  masquerade as "the glossary disappeared"), and the median verification score is compared only when both
  sides graded the same number of chapters, because a book that gained a chapter is a different book.

The account is printed and stored (`ledger.json`'s `signals` field), because a verdict with no numbers
next to it is a verdict nobody can argue with afterwards — least of all the diagnostics team. A ticket
closes through the same comparison (`closureFromComparison`, reached from `delivery.js`'s
`closeTicketOnDeliverable`), so "did it help?" has one answer in this codebase rather than two. See
gotcha 73.

**The run lock (`utils/runlock.js`) — "is something else writing these volumes right now?"** A manager
with the authority to re-run steps makes a new failure possible: starting a step while a run is already
working on the same folders. The result is invisible to every check in docs/delivery-layer.md — the artifact ends half-built
by one process and half by the other, and "is the file there?" says yes. So `<POSTMORTEM_DIR>/run.lock`
records who is running, and `index.js` and every gulp task take it before doing anything (outside the
hooks, so a refusal costs no model container switch — gotcha 22). Nesting is counted, so a gulp child
spawned by `index.js` joins its parent's lock rather than competing with it, and only the writer deletes
it. Two directions matter: the lock is **advisory to the pipeline** (a lock file that cannot be written is
a warning, never a reason a 12-hour run dies) and **binding to the manager** (for the manager, "I cannot
tell" is "no" — deciding whether it is safe to act is its whole job). Liveness is the pid; a pid this
machine cannot check — a lock written on another host — is treated as in progress, with the file to delete
named out loud. **And "the same run" is only half of what makes a lock ours: it also needs a live
holder.** Act mode continues under the newest recorded run id so the ledger's memory of what that run
already tried stays legible, which means a lock left by a process that died mid-run carries the *same*
id the next attempt will use. Matching on the id alone made that ghost lock "ours": the new process
joined a lock it was not allowed to delete, and left it there — for every later run too, because each
one reuses the id (gotcha 91). The lock lives in `POSTMORTEM_DIR`, not per series, so two concurrent
runs of two different series collide; the answer is a separate `POSTMORTEM_DIR` per series, and the
refusal says so. See gotcha 72.

**The structural-failure marker.** `isStructuralError` is an in-process flag
(`err.structural === true`), and a child process cannot hand its error object back.
`withStructuralMarker` in `gulpfile.js` writes
`.postmortem/last-structural-failure.json` before rethrowing, and `index.js` reads it
(deleting it before each step, so a step can only report its own outcome). Without
it, the "a structural failure is never continued past" rule would have to be guessed
from an exit code or from error text — and guessing from text is the pattern gotcha
55 exists to prevent. See gotcha 66.

**The autopilot (`autopilot.js`) — the manager driving the loop.** Everything above is a piece of the
product; the loop is what makes it run itself. Each iteration: read the state (`readWorkingState` →
`planResume`), open the ticket the triage says is the answer (`delivery.js --open-ticket`, idempotent,
so calling it every iteration cannot write the same question twice), build the menu the state actually
supports, make **one model turn whose tools ARE that menu** (`utils/manager.js`), and carry the answer
out by spawning the account owner's own command in its own process.

- **Why commands and not functions.** A code fix takes effect at a process boundary, not inside a
  running one (gotcha 66): Node caches a module the first time it is required, and `gulpfile.js`
  requires all ten task modules at the top of the file. A patch that changes `utils/prompt.js` — or
  `delivery.js` itself, which is not a banned path — would be invisible to a loop that had already
  required them, so the loop would go on executing the pre-patch gates for the rest of the run.
  Spawning the same command the account owner would type is the honest reload boundary, and it is
  cheap here because the idempotent skip-checks make a re-run nearly free. It also means the loop
  cannot bypass a gate by reaching past one, which is the difference between a manager and a wrapper.
- **Exactly one `run` move per plan.** `delivery.executableSteps(plan)` returns the plan's whole
  executable sequence and executing it runs the whole sequence — `runActPlan` stops at the first
  refusal or failed step, and the sequence IS the triage's answer. Offering the later steps
  separately would let the manager pick one and skip the cascade, and a skipped cascade is worse than
  a re-run: the later volumes stay built on the artifact that was just repaired. The label names the
  steps the sequence then runs, so the manager is choosing a sequence, not a step.
- **A failed step is re-read, not retried.** A command that exits "it did not finish" does not end
  the loop: the step ran, the ledger recorded what it produced, and the next reading is where the
  triage is allowed to say the answer for that step is now a question. Quitting at the failure is
  what made a real run look unrecoverable — the manager spent its one allowed attempt, the attempt
  produced the evidence that the answer is a code question, and the loop ended before that evidence
  could be read, so the diagnostics team was never called and the dev team was never reachable. Two
  exits ARE a stop, and neither is a step that failed: a command that could not be started, and
  exit 2, where the request itself was refused — re-asking for an illegal move is a guard with a
  retry button on it (gotcha 70). `movesAfterFailures` is the matching half: the step this
  invocation already ran and lost does not get a second `run` move, so the only thing "keep going"
  can lead to is the ladder that already exists — ticket → diagnostics → a code change, or an
  escalation that says the account owner has to decide (gotcha 90).
- **Watch mode is the default, and it writes nothing.** No ticket, no ledger entry, no plan file, no
  run lock — it prints the decision, the whole menu it was offered, and the exact command act mode
  would have run. That is the only safe rehearsal: act mode refuses `--no-write` with `--mode=act`
  because a recorded intervention that did nothing poisons the ledger that exists to catch a spin
  (gotcha 72). In watch mode the question the triage would write is shown as a clearly-labelled
  `PREVIEW` record, because otherwise `diagnose` is an illegal move and the manager's only answer
  would be `escalate` — a correct reading of a state whose honest answer is a question.
- **No run lock of its own.** `delivery.js --mode=act` takes one under the newest recorded run, so a
  loop-wide lock would make its own children refuse; and holding a lock across the whole loop would
  claim "a run is in progress" during the `fix` branch, which is exactly the case gotcha 66 forbids —
  a patch may not land while a run is working on the volumes. What the loop does instead is check
  `runInProgress()` before each action and stop if something else started, and let each command
  enforce its own rule.
- **An accept is the one move it will not take on the manager's word.** `safeToAcceptAutomatically`
  decides: ordinary project code, the pinned checks green, no warning on the proposal, nothing the
  team escalated in prose, and no measured regression on the deliverable. Anything else stops and
  names the account owner. Rejecting needs no such gate — it is the direction that undoes work. Both
  are followed by the command that finishes them (`fix.js --commit=<id>` / `--revert=<id>`), because
  accepting is not landing a change and rejecting is not undoing one, and a rejected-but-not-reverted
  patch sits in `unresolvedPatches()` and gates the next run.
- **`escalate` is a branch, not a failure state.** A Tier C move is one the manager may name and
  never make, so a loop that could only act would have to work around the rule instead of ending on
  it. The loop prints what the account owner has to decide and exits 1.
- **The manager decides by calling a tool, so there is nothing to transcribe.** It used to answer a
  fenced JSON block, and that made every identifier its job: a ticket id is
  `TCK-delivery-2026-10-06T18-27-38-632Z-1` (43 characters) and an option appends `/O2` to it. On
  2026-10-07 one came back as `…2026-10-27-38-632Z-1` — the right option, the ticket mangled — which
  stopped a loop that had already paid 7.1M input tokens for the diagnosis it was about to act on. On
  2026-10-08 the same class fired in a field nobody had looked at: the menu offers one `run` move, the
  only place its step is written out is inside the sentence describing it, the brief said "the step
  exactly as offered", and the model copied the sentence (gotcha 84). So the menu is now the tool list:
  `move1_run_glossary`, `move2_diagnose`, `move3_judge_reject`, each carrying its own step, ticket,
  option, patch and outcome, and each taking only the prose the model is actually for — the reason, the
  answer, the note. A move the state does not support is not a move the gate catches after the fact; it
  is a tool that is not there. The first call records the decision and a second call in the same turn is
  refused by the tool, because the loop re-reads the run after one move and a second move in the same
  turn is a move no gate has assessed.
- **The other two delivery answers take the same shape, in its second form.** The manager had a menu to
  turn into tools; the diagnostics team and the dev team write their answer from scratch, so the answer
  itself became the tool: `submit_diagnosis(cause, options, recommend?, questions?, read?, ownerNote?)`
  and `submit_proposal(files, summary, why, couldBreak, expected, verify, questions?, ownerNote?)`. The
  provider checks the fields before this code ever sees them, so a `verify` the role forgot is a tool
  error it can answer again inside the same turn rather than a parse failure that ends an uncapped turn;
  the answer is on the record at the moment it is given, so a turn that dies afterwards still has one;
  and a second call in the same turn is refused by the tool. The dev team's version matters most, because
  by the time it answers it has already edited files — an unreadable proposal used to leave a changed
  working tree with no record of what the team believed it had done. Neither role is *forced* to use the
  button: `parseDiagnosisReply` and `parseProposalReply` stay, fail-closed, and the record says which
  half carried the answer (`answeredBy: "tool"` on the ticket's diagnosis, on the patch record). The
  button writes nothing, so the read-only guarantee and the banned-path table still cover exactly the
  file tools they were written against. Both prompt files describe the fields without naming a mechanism,
  because a prompt that says "answer with one fenced JSON object" beside a note that says "call the
  answer tool" gets the fenced block. See gotcha 87.
- **A name written wrong gets one correction; a guard gets none.** The text path is kept — a local
  endpoint on this machine sometimes answers in prose instead of calling a tool (gotcha 18) — and there
  the old failures still happen, so the gate repairs the two where the state already holds the name
  (`repairTicketReference`, `repairStepReference`) and reports the repair in the decision record rather
  than applying it silently. A refusal of the shape "there is no such ticket / option / question / patch
  / move", or one that says the manager called nothing, is re-asked **once**, with that refusal printed
  in front of the model (`NAMING_SLIPS`, and `renderManagerBrief`'s `correction` section): the refusal
  already lists the names that exist — and since gotcha 84 it prints them in the form the caller has to
  write back, because printing the menu's sentence is what taught a model to copy the sentence. A
  refusal that is a **guard** — a banned option, an answer that cites the code, an `end` the records do
  not prove, a second diagnosis of an answered ticket — is never re-asked, because asking a role to try
  a guard again is asking it to rephrase the same move until the guard flinches (gotcha 70).
- **`AUTOPILOT_MAX_ITERATIONS` (default 12) is a wall, not a budget.** The anti-spin gate needs a
  repetition and the per-step allowance needs an intervention; a loop making legal, different,
  non-repeating moves that never reach a provable end trips neither, and it should not run overnight.

There is deliberately no `--dry-run`: it is a pipeline flag that also suppresses hooks, and on a
machine where the hooks decide which model container answers, that would make the manager's model
switch silently optional (gotcha 22). See gotcha 76.

### 3.7 The delivery layer's own after-run check (`utils/delivery-audit.js`)

Everything above is supervised. A pipeline step finishes, `utils/postmortem.js` asks what it left
behind, the finding reaches the ledger, and the next run knows whether re-running is worth paying for.
The four delivery commands — `npm run delivery`, `npm run diagnose`, `npm run fix`,
`npm run autopilot` — had never been asked that question, and they are the layer that decides whether
a failed run gets repaired, escalated, or left alone.

That asymmetry is worth naming precisely, because these commands do not write reports. They write the
**inputs** everything else in the layer is built on: the plan of record is what the next run reads to
find out what was already tried; a ticket is the only door to the diagnostics team and to a code
change; a patch record is the only evidence of code that changed on the pipeline's authority; the
ledger is the anti-spin gate; and a run lock left behind by a process that has exited makes every
later act-mode command refuse to start, which looks like rigor and is a run that cannot be started.
A corrupt one of those is not a missing report — it is the layer quietly losing the ability to
remember, decide, or start.

**The three questions, in increasing ambition.**

1. **Are the records there, and are they shaped right?** Declared in `utils/artifacts/delivery.js` as a
   third scope beside `volume` and `series` — `run`, resolved against `POSTMORTEM_DIR` — and assessed
   by `utils/postmortem/scope.js` with the same `assessFile` that assesses a glossary. The expectations
   are gated by `when` predicates that read what the command *claims* it wrote, because `--no-write`,
   `--open` and `--status` legitimately write nothing; `required` then means "you said you wrote it and
   the disk says you did not". `autopilot` declares an empty list on purpose: it writes nothing itself,
   every move being a child command that files its own record.
2. **Do the records agree with each other?** A file-presence check cannot ask these, which is why they
   are in `utils/delivery-audit.js` rather than in the spec table. A channel that does not parse is
   `record-unreadable` HIGH — and note the direction: `readTickets` / `readPatches` / `readLedger`
   already refuse to report a corrupt file as an empty one (gotcha 33), so the audit is carrying an
   honesty rule that the readers had no way to announce. A patch answering a ticket that is not in the
   ticket file is `record-orphan`: code changed whose justification has gone. A ticket marked
   `answered` with no diagnosis behind it is a menu the manager picks from without being able to read
   it. A ticket `closed` with no measured outcome is HIGH, because the ledger will count it as a move
   that was tried. A duplicate id is named, because every lookup takes the first and half the record is
   unreachable. A plan naming a step nothing declares, or claiming an act pass with no execution list,
   is the run forgetting from the other direction. A lock left by a process that is gone is
   `run-lock-stale` HIGH.
3. **Did the command do what its exit code says it did?** An exit 0 is a claim. `claimsFromInvocation`
   reads the claims off the command line and the exit code rather than taking them from the command
   being audited — a value a command threads down its own call stack is the command grading its own
   homework, and the failure this exists for is the command being wrong about what it did. `diagnose`
   exiting 0 with no diagnosis on the ticket, `fix --commit` leaving a patch `proposed`, `delivery
   --accept-patch` leaving it unjudged, `--choose` recording a different option: each is
   `claim-unsupported` HIGH. This is the delivery layer's version of "never let a stage persist empty
   output" (gotcha 2) — the stage finished, and what it finished with is not there.

**A live run lock is not a finding.** While a run is going on the lock is the gate, and the audit has
nothing to say about it. Asked afterwards it is evidence. Reporting the lock working as a defect is
how a check gets switched off, and the same rule keeps `--no-write`, `--open` and `--status` clean.

**What it deliberately does not do.** It never changes the command's exit code and never refuses the
command: it runs *after* the work, and by then the work is done — turning a completed run into a failed
one would teach the operator to run the command with the audit disabled. It prints, writes
`<step>.md` + `<step>.json` beside the other post-mortems, and appends an `assessment` entry to the
ledger, which is how a delivery finding reaches the next run's triage instead of ending as a line on a
console. That entry is not counted as a move: `attemptCount` and `isSpinning` select only on
`intervention`, so an audit can never spend an intervention or launder a spin.

**Why it is a leaf module.** `utils/tickets`, `utils/patches`, `utils/ledger` and `utils/runlock` each
resolve their own folder through `utils/postmortem`. A module *inside* the postmortem layer that
reached back for them would close a require cycle and hand them a half-built barrel — the failure would
appear as `postMortemDir is not a function` at the first path call, far from the cause. So the
cross-record questions live in a module nothing else requires, and `utils/postmortem/scope.js` is kept
free of any knowledge of what a ticket is.

**The findings the run itself produces, and no record shows.** `auditDeliveryRun({ extraFindings })` is the door a caller contributes findings through, and it exists for one fact that is otherwise invisible: a manager decision the layer refused. The loop prints it, the plan stops, and nothing on disk says why — the ticket is unchanged, no patch was opened, no intervention was recorded, so the next run's triage reads a run that simply did not finish. `autopilot/cli.js`'s `refusalFindings()` writes it: `manager-refused` HIGH when the loop stopped because the manager's own answer was refused (a guard it may not rephrase its way around), `manager-corrected` LOW when the naming slip was repaired and re-asked, and `loop-crashed` when the loop threw. It is written by the CLI and not inside `runLoop` on purpose: `test/test-autopilot.js` pins the loop's watch-mode promise that it writes nothing, and a guarantee a test drives directly is the one worth keeping. The ledger entry stays `kind: "assessment"`, which is what stops a refusal from spending an intervention or laundering a spin (gotcha 85).

**The first thing it found** was in this repository's own `.postmortem/`: a `run.lock` left behind by a
`delivery.js act` run whose process was gone. Nothing had noticed, and every later act-mode command
would have refused to start against it. See `test/test-delivery-audit.js`, which seeds a healthy run,
asserts the audit reports nothing, and then plants one defect per finding class.
