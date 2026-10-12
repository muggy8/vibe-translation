---
description: Scope this as one slice and hand it to a fresh worker session
subagent: false
---

Handle this as one slice, following the `dispatching-slices` skill.

First tell me, in two or three lines, what you think the slice actually is, what "done" looks
like, and what could block it. If it is really two slices, say so and ask which one first.

Then measure the current state yourself (HEAD, whether the tree is clean, `npm test` baselines,
and the row counts or checksums this slice could damage), and dispatch it to a **fresh**
`builder` session with that state written into the prompt. Do not resume an earlier worker.

When the worker returns, verify it against the disk before you tell me the outcome, and commit
only what you have confirmed.

The slice: $ARGUMENTS
