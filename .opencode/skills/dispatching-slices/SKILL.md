---
name: Dispatching Slices
description: Use when handing implementation work to a worker session in this repository — how to scope a slice, what to put in the dispatch prompt, and what to verify before telling the account owner anything
---

## When to dispatch, and when not to

Dispatch when the work changes code, runs the pipeline, or touches the books. Do the rest
yourself: reading a file, answering a question, measuring something small, explaining what a
failure means. A dispatch costs a fresh session and a full round of verification; do not pay
it to look at one function.

One slice per dispatch. If you find yourself writing "and also", that is two dispatches.

## Scope the slice before you write it

Write down, for yourself:

- the defect or capability, in one sentence;
- what "done" looks like, as something checkable;
- what must not change (the guards, the severity ladder, the banned-patch paths, the corpus);
- the token cap for real model calls, if any;
- the order, if there are several parts — say which part to stop at if one blocks another.

## The dispatch prompt

A worker inherits nothing from your conversation. Write it as if to a competent colleague who
has just walked in.

```
## State you are starting from
HEAD is <commit> "<subject>". Tree clean / N files uncommitted (<list>).
Measured just now: npm test <exit>, loop baselines <n> and <n>, prompt audit <n> checks
/<n> findings. Volume 01: <rows> rows, sealed, accepted [<grades>], checksum <md5>. …

## Already finished — do not redo
<list, with the commit each landed in>

## The slice
<numbered parts, in order>

## Constraints
<copied from AGENTS.md §4 and the gotchas that touch this folder>
No new dependency. CommonJS. JSDoc using types.js names. Do not weaken a guard or the
banned-patch-path table. Commit nothing. Tests on fixtures only — no test reads the real
17 volumes. Writes only into <folders>. Stop and report before <N> model tokens.

## Report
<numbered sections you want back, including "any disagreement with what I asked for">
```

Include the numbers you measured. A worker that is told "the tree is green" will trust it;
a worker that is told the exact baselines will notice when they move.

## Never resume a worker

Do not pass a previous session's id. A session kept alive across several tasks starts
answering from its own compressed history instead of from what it just did, and it produces
reports that read well and describe nothing. Fresh session, every time.

## Verify before you speak

Run these yourself, or send the `verifier` subagent and spot-check its headline numbers:

| claim | how to check it |
| --- | --- |
| "I built X" | `git status` — is the file there, and how long is it? |
| "the suite is green" | `npm test` — exit code, loop baselines, audit lines |
| "the record now holds N rows" | query `series.db` directly |
| "it cost N tokens" | read the `# Tokens:` headers in the series `.run/logs/` transcripts |
| "nothing was destroyed" | compare the checksums you recorded before the dispatch |
| "the guard still holds" | read the diff of the guard file and say which way it moved |

**A report is a hypothesis.** If it does not match the disk, tell the account owner that in
plain words — including that a worker reported work that does not exist — and re-dispatch in
a fresh session. Do not quietly patch the gap yourself.

## Committing

You commit, not the worker. Scoped `git add <paths>`, never `git add -A`, never `git -C ..`.
The message carries the measurements: the row counts, the grades, the token totals, the
false-positive rates, and what was found that nobody predicted. Adjectives are not evidence.

## After the slice lands

Update the index: `AGENTS.md` if a command, setting or route changed; the matching map doc;
the plan of record if a slice finished; a gotcha only if something genuinely surprising was
learned. Then tell the account owner what it means for the next step.
