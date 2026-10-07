# AGENTS.md — ai-client

**This file is the index.** The map, the architecture, the environment reference and the
hard-won gotchas live in `docs/`, one topic per file. Read the table in §2 before you open
anything, and read the gotchas that touch the area you are changing — they are the reason
most of this code looks the way it does.

## 1. What this is

An agentic AI client (v2.0.0, CommonJS, Node ≥ 22.19) that processes a light-novel series
**volume by volume** and produces translation-support artifacts — a glossary, a character
voice reference, a style guide, a wiki, a consistency audit — and then the translation
itself, chapter by chapter, through a multi-model chain (translate → verify → retranslate →
polish). It talks to any **OpenAI-compatible endpoint** through the Vercel AI SDK +
`@openharness/core`; tool-calling agents read the sources and write the outputs themselves
through sandboxed file tools.

On top of that sits a **delivery layer**: a deterministic step runner that assesses every
step, a run ledger that remembers what a run already tried, a ticket channel, a read-only
diagnostics role, a code-changing dev team, a delivery manager and a loop that drives them
(`index.js`, `delivery.js`, `diagnose.js`, `fix.js`, `autopilot.js`). See
`docs/delivery-layer.md`.

### Quickstart

| Command | What it does |
|---|---|
| `npx gulp discover` | Series intake only: work out the volumes, order, names, exclusions; write `translation-target.json` + `translation-plan.md` |
| `npx gulp glossary` / `character-voice` / `style-guide` / `jump-in-wiki` | One pre-production task (all volumes) |
| `npx gulp consistency-audit` | The cross-artifact sign-off (writes `consistency-report.md`) |
| `npx gulp translate` / `translate-qa` / `polish` | The translation stage (`--allow-fail` / `--allow-no-glossary` override the entry gate) |
| `npx gulp` (default) | All nine in order |
| `npm run pipeline` | **The pipeline one step at a time** (`node index.js`): each step in its own process, each assessed, each recorded. `--stages=a,b`, `--post-mortem=off`, `--ledger=off`, `--fail-on=high\|medium\|never`, `--list` |
| `npm run delivery` | **Where the run stopped, and what to do about it.** `--mode=report` (default) proposes nothing; `--mode=act` executes the plan through the gated step runner |
| `npm run diagnose -- --ticket=<id>` | Answer a ticket with a **read-only** agent (it may open the code and the logs; it may not write) |
| `npm run fix -- --ticket=<id>` | Answer a ticket with a **code change**, inside a boundary; the machine runs the pinned checks |
| `npm run autopilot` | The manager driving the loop. Default `--mode=watch`: decide, print, write nothing |
| `npm test` | Offline tests (no AI, no network) — pure functions **plus** whole-task runs against the scripted model server in `test/fake-backend.js` |
| `npm run pipeline-loop` | **The whole pipeline offline** on a two-volume fixture, then a second pass that must make zero calls, then a 21-rule audit of what the pipeline actually asked the model |
| `npm run smoke` / `npm run calibrate` | Live checks (they call the real endpoint — not part of `npm test`) |
| `... --dry-run` / `--force` / `--volume NN` / `--chunked` | No AI calls (prompt dumps to `.dry-run/`) / regenerate anyway / one volume / force the chapter-by-chapter path |

## 2. Which doc to read

| You are … | Read |
|---|---|
| looking for what a file is for | `docs/map-core.md`, `docs/map-helpers.md`, `docs/map-preproduction.md`, `docs/map-translation.md`, `docs/map-tests.md`, `docs/map-delivery.md` |
| changing how a task runs, the agent loop, the QA loop, the processing-mode decision, the hooks | `docs/architecture.md` |
| working on the delivery layer (post-mortem, ledger, tickets, resume triage, acceptance test, patches, manager, autopilot, run lock) | `docs/delivery-layer.md` |
| working on a pre-production pipeline (glossary / wiki / character voice / style guide / audit / handoff) | `docs/pipelines.md` |
| working on the translation stage (translate / verify / retranslate / polish) | `docs/pipelines.md` §8.5 |
| adding or renaming a setting | `docs/environment.md` |
| writing code or tests here | `docs/conventions.md` |
| about to change a behavior you do not understand | **the gotchas** — `docs/gotchas-1-20.md`, `docs/gotchas-21-45.md`, `docs/gotchas-46-63.md`, `docs/gotchas-64-69.md`, `docs/gotchas-70-78.md` |

Each map doc ends with a table of the **implementation folders** its module was cut into
(§3 below): what each file in the folder holds and how long it is.

Code comments cite `AGENTS.md gotcha N`. The numbers are unchanged from when the gotchas were
one file: the list now lives in the five `docs/gotchas-*.md` slices (1–20, 21–45, 46–63,
64–69, 70–78), and each slice says which part of the list it holds.

## 3. The implementation folders

Every large module is a **thin barrel** that re-exports a folder of cohesive submodules.
`utils/translate.js` is 62 lines; `utils/translate/` is the code. This exists so an agent can
read one concern at a time instead of a 3,300-line file, and so a failure points at one file.

**The barrel is the public surface, and it is not negotiable.** Node resolves `translate.js`
before `translate/`, so every `require("./utils/translate")`, every test, and every
monkey-patch (`harness.runOneShot = …`) keeps working unchanged. When you split a module:

- keep every exported name available from the barrel, including the re-exported helpers;
- split along the seams the file already documents (its `// ─── Section ───` banners);
- never move a **guard table** out of its module's protected paths: `utils/tickets/`,
  `utils/resume/`, `utils/delivery-verify`, `utils/ledger`, `utils/runlock`,
  `utils/patches/` are banned patch paths for the dev team, exactly like the single files
  they replaced (`utils/patches/rules.js`) — the ban covers the barrel and the folder alike,
  and three of them are still single files today, so splitting one must not change what
  the ban covers;
- `__dirname` in a subfolder is the subfolder: a root-level task module needs a
  `projectRoot` alias passed down, a `utils/` module needs a `utilsDir` alias.

| Barrel | Folder |
|---|---|
| `harness.js` | `ai/` (10 files) — **not** `harness/`, which holds the planned REPL/PTC documents |
| `get-translation-target.js` | `intake/` |
| `glossary.js`, `character-voice.js`, `style-guide.js`, `jump-in-wiki.js` | `glossary/`, `character-voice/`, `style-guide/`, `jump-in-wiki/` |
| `translate.js`, `verify-translate.js`, `polish.js`, `retranslate.js` | `translate/`, `verify-translate/`, `polish/`, `retranslate/` |
| `delivery.js` | `delivery/` |
| `utils/translate.js`, `utils/source.js`, `utils/context.js`, `utils/manager.js`, `utils/diagnostics.js`, `utils/patches.js`, `utils/resume.js`, `utils/tickets.js`, `utils/qa-loop.js`, `utils/series-run.js` | the matching folder under `utils/` |

`test/module-layer.js` is the helper that lets a test which scans source text follow a module
into its folder (`readModuleLayer(rootDir, "utils/translate.js")`).

## 4. The rules that do not bend

1. **`harness.js` is the only way to talk to the model.** One-shot calls, agent handles, the
   gated file tools, the epub tools, the logging, the runaway/truncation guards, the idle
   deadline. Never bypass it to reach the provider. → `docs/architecture.md`
2. **The sandbox is the sandbox.** `createGatedFsTools` confines writes to the volume folder,
   refuses archives, and does not offer `deleteFile` at all. Do not weaken it, and do not
   advertise a tool the sandbox would refuse. → gotcha 8, gotcha 60
3. **A guard the role can switch off is not a guard.** The banned-option filter, the closed
   action menu, the banned patch paths, the pinned checks and `CONTEXT_MANAGED_ROLES` have no
   env knob on purpose. → gotcha 70, gotcha 75, gotcha 78
4. **Never let a stage persist empty output.** `runOneShot` throws on empty; agent stages are
   guarded by `assertWrote` / `assertRealOutput`. If you add a stage, add both guarantees. →
   gotcha 2, gotcha 58
5. **A cumulative artifact is amended in place, never reproduced.** The workflow copies the
   previous volume's file in, hands the agent a map of it, and a no-AI gate checks that nothing
   was lost. → gotcha 64, gotcha 65, gotcha 68
6. **Prompt files stay mode-agnostic**; mode-specific text is appended in code
   (`AGENT_TOOLS_NOTE`, `DIAGNOSIS_TOOLS_NOTE`, `DEVTEAM_TOOLS_NOTE`).
7. **JSDoc on every function**, using the named types from `types.js`. New code without JSDoc
   is a review blocker.
8. **Tests are plain `assert`, no framework**, and they point at a fixture — never at whatever
   `.env` says. A test that exercises the runner must not be able to touch the corpus it is
   protecting. → gotcha 69
9. **Update the docs after changes.** `docs/` is the current map; an agent reading it should be
   able to rely on it. If you add, remove or move something, update the map doc, the barrel
   table above if it is a split, and the gotcha list if you learned one.
10. **This repository is bigger than this folder.** The git root is the parent `oresuki/`
    directory, so git paths appear as `ai-client/…`, and the tree outside `ai-client/` holds
    the account owner's in-progress translation output. Scope every git call; never `git add -A`.
    → gotcha 75
11. **`npm test` is the gate**, and its last act is the offline pipeline loop plus the prompt
    audit. A green unit suite that breaks what the pipeline asks the model is still broken. →
    gotcha 62, gotcha 63

## 5. Ownership

You are the owner of this repository. all code in this repository is written by you and other
agents like you. Do not assume that the user understand anything about the inner workings of
this project nor should you assume that anything you find in this project was written by the
user. The features in this project are added, maintained, and managed entirely by AI agents
and the user acts as a client who requests features which you implmement.

## 6. Communication

When communicating with the user, you should assume that the user is intelegent but not
knowledgeable. As mentioned earlier, you are the owner of hte code in this repo, as such, you
should not expect any particular terms found in the code or the comments to be understood by
the user. When formulating your final answer, keep the following points in mind as you produce
your final answer.

- Avoid using advanced jargon and specialized terminolgy where possible.
- Just because a term or jargon is used in the code doesn't mean the user udnerstands the
  meaning of those words.
- Ask yourself "Would a general audiance software engineering influencer/educator use these
  terms?" If not, then you should probably avoid the use of the jargon in question.
- Ask yourself "How likely would a term appear in a PhD research paper?" If the odds are high,
  it's probably best to avoid using the jargon in question.
- When you are producing your final answer, instead of using specialized jargon, you can use
  analogies or metaphors instead.
- When analogies or metaphors fail, psuedo code can be used as a last resort.
