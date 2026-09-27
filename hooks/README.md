# Pipeline hooks (per-machine)

Optional, git-style hooks that run **before and after each pipeline step** and
around the **whole default run**. They let each machine attach its own
side-effects (git sync, notifications, backups, …) **without any change to the
committed source or `package.json`**.

- **Entirely optional.** With no `hooks/` directory the pipeline runs exactly
  as before. A missing hook file for a step is skipped silently.
- **Per-machine.** Your real hook files live in `hooks/` and are **gitignored**.
  Only this `README.md` and the `*.sample` templates are tracked (see
  `.gitignore`). Copy a sample to a real name and `chmod +x` it to enable it.
- **Dumb runner.** The hook runner (`utils/hooks.js`) just *execs an
  executable file* with environment variables — it does not interpret your
  script, load any npm package, or modify `package.json`. A hook can be a shell
  script, or a `#!/usr/bin/env node` / `python` script using built-ins. It
  shells out to whatever the local machine already has.

## Where hooks live

Default: `<project root>/hooks/`. Override the directory with the
`AI_CLIENT_HOOKS_DIR` environment variable (the git `core.hooksPath` analogue).

## Hook files (first existing name wins)

| When | Files looked for |
| --- | --- |
| before / after `glossary` | `pre-glossary` / `post-glossary` (or `.sh` / `.js`) |
| before / after `character-voice` | `pre-character-voice` / `post-character-voice` (or `.sh` / `.js`) |
| before / after `style-guide` | `pre-style-guide` / `post-style-guide` (or `.sh` / `.js`) |
| before / after `jump-in-wiki` | `pre-jump-in-wiki` / `post-jump-in-wiki` (or `.sh` / `.js`) |
| before / after `consistency-audit` | `pre-consistency-audit` / `post-consistency-audit` (or `.sh` / `.js`) |
| before / after `translate` | `pre-translate` / `post-translate` (or `.sh` / `.js`) |
| before / after `verify-translate` | `pre-verify-translate` / `post-verify-translate` (or `.sh` / `.js`) |
| before / after `retranslate` | `pre-retranslate` / `post-retranslate` (or `.sh` / `.js`) |
| before / after `translate-qa` (the QA loop as a whole) | `pre-translate-qa` / `post-translate-qa` (or `.sh` / `.js`) |
| before / after `polish` | `pre-polish` / `post-polish` (or `.sh` / `.js`) |
| around the whole default run | `pre-pipeline` / `post-pipeline` (or `.sh` / `.js`) |

A hook file must be **executable** (`chmod +x`) and start with a **shebang**
(`#!/usr/bin/sh`, `#!/usr/bin/env node`, …). Present-but-not-executable files
are skipped with a warning (they never crash the pipeline).

## Environment variables injected into every hook

| Variable | Meaning |
| --- | --- |
| `AI_CLIENT_TASK` | The step name (`glossary`, …, or `pipeline`). |
| `AI_CLIENT_PHASE` | `before` or `after`. |
| `AI_CLIENT_SERIES_DIR` | Absolute `SERIES_LOCATION` (resolved). |
| `AI_CLIENT_SERIES_NAME` | The `SERIES_NAME`. |
| `AI_CLIENT_DRY_RUN` / `AI_CLIENT_FORCE` / `AI_CLIENT_CHUNKED` | `1`/`0` for the matching flag. |
| `AI_CLIENT_VOLUME` | The `--volume` argument (empty when unset). |
| `AI_CLIENT_TASK_SUCCEEDED` | `after` hooks only: `1`/`0` (whether the step resolved). |
| `AI_CLIENT_TASK_ERROR` | `after` hooks only: the task error's first line (empty on success). |

The hook **also inherits your whole environment** (the OS environment plus the
project `.env`), so you can read e.g. `$SERIES_LOCATION` and your own
machine-local variables. Keep machine-specific secrets (API keys, recipients,
paths) in a local file the hook sources itself — e.g.
`[ -f "$HOME/.ai-client/hooks.env" ] && . "$HOME/.ai-client/hooks.env"` — so they
never enter the repo.

## The contract

- **Exit `0`** → success; the pipeline continues.
- **Before-hook exits non-zero** → the step **aborts** (the task does not run,
  and its after-hook does not run).
- **After-hook exits non-zero** → the run **fails** — *unless the task itself
  already failed*, in which case the after-hook error is logged and the
  **original task error** is what propagates (so a "task failed" notification
  can still fire).
- **`--dry-run` runs no hooks** (dry-run is side-effect-free).

Hook stdout/stderr and start/finish lines are written to the run log
(`.logs/<timestamp>/summary.log`) and stderr in real time.

## Example 1 — git-manage the series, one branch per step (per-step model)

Enable the per-step samples:

    cp hooks/pre-jump-in-wiki.sh.sample hooks/pre-jump-in-wiki.sh && chmod +x hooks/pre-jump-in-wiki.sh
    cp hooks/post-jump-in-wiki.sh.sample hooks/post-jump-in-wiki.sh && chmod +x hooks/post-jump-in-wiki.sh

What they do:

    # before: start from a clean main and branch for this step
    cd "$AI_CLIENT_SERIES_DIR" && git checkout main && git pull && git checkout -b jump-in-wiki main
    # after: commit, merge back, push
    cd "$AI_CLIENT_SERIES_DIR" && git add . && git commit -m "completed jump-in-wiki" \
      && git checkout main && git merge jump-in-wiki && git push

## Example 2 — whole-run git sync (one branch for the entire pipeline)

Instead of per-step branches, wrap the whole default run once with
`pre-pipeline` / `post-pipeline` (see those `.sample` files). **Pick one model**
(per-step or whole-run) — don't run both git models at once.

## Example 3 — notify a person when a step finishes (no npm deps)

A `post-<task>` hook can send an email using only what's on the machine — no
`package.json` change, no `npm install`:

    #!/usr/bin/sh
    set -eu
    [ -f "$HOME/.ai-client/hooks.env" ] && . "$HOME/.ai-client/hooks.env"   # NOTIFY_* keys
    status="ok"; [ "$AI_CLIENT_TASK_SUCCEEDED" = "1" ] || status="FAILED"
    # Option A: classic MTA
    printf 'The %s step %s on %s\n' "$AI_CLIENT_TASK" "$status" "$(hostname)" \
      | mail -s "[$AI_CLIENT_TASK] $status" "$NOTIFY_EMAIL"
    # Option B: HTTP mail API via curl (comment out A)
    # curl -sSf "$NOTIFY_API_URL" -H "Authorization: Bearer $NOTIFY_API_KEY" \
    #   -H "Content-Type: application/json" \
    #   -d "{\"subject\":\"[$AI_CLIENT_TASK] $status\",\"to\":\"$NOTIFY_EMAIL\"}"

## Example 4 — switch the local model container per translation stage

The translation stage (`translate` → `translate-qa` [verify ↔ retranslate
loop] → `polish`) uses **two different models**. On a local setup the model
containers share one host port, so only one can serve at a time — the
per-machine hooks do the switching, and the task code never touches the
containers (it only checks `GET /v1/models` before its first call, via
`harness.assertModelServing`).

`model-switch.sh` (copy of `model-switch.sh.sample`) starts the container of
the compose dir you give it: if that container already serves the port it
no-ops (idempotent — state file `hooks/.model-switch-state`), otherwise it
stops the current port owner, `docker compose up -d` the target, and polls
`/health` until the model is loaded. The pre-hooks just call it:

    # hooks/pre-translate.sh        (Hy-MT2 translates)
    exec "$(dirname "$0")/model-switch.sh" /path/to/Containers/Hy-MT2
    # hooks/pre-verify-translate.sh (Qwen verifies)
    exec "$(dirname "$0")/model-switch.sh" /path/to/Containers/Qwen3.8-27b
    # hooks/pre-retranslate.sh      (Hy-MT2 again)
    exec "$(dirname "$0")/model-switch.sh" /path/to/Containers/Hy-MT2
    # hooks/pre-polish.sh           (Qwen again)
    exec "$(dirname "$0")/model-switch.sh" /path/to/Containers/Qwen3.8-27b

A full default run therefore makes at least 4 container switches
(Hy-MT2 → Qwen → Hy-MT2 → Qwen → Qwen — the last two can be the same
container already up, which the state file turns into a no-op). The
`translate-qa` loop fires these batch hooks repeatedly — up to two switches
per round (→Qwen before each verify batch, →Hy-MT2 before each retranslate
batch) — and a repeat switch is a no-op when the right container already
serves the port, so a round that ends on the model the next round needs
costs nothing. The `pre-/post-translate-qa` hooks wrap the WHOLE loop and
must not switch models. Note the local containers may all advertise the same
model alias (e.g. `local`), which is exactly why the switching lives here —
the ai-client cannot tell the models apart by name.

## Disabling a hook

Delete (or rename) the hook file. `*.sample` files are inert — they never run,
because the runner only matches exact hook names.
