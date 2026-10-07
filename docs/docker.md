# Running the pipeline in Docker

Clone, drop your books in `epub_source/`, point `.env` at your model server, run.

Part of the ai-client documentation; the entry point is [AGENTS.md](../AGENTS.md).

---

## 1. What the container is, and what it is not

The container runs **the pipeline**. It does not run a model: it is a *client* of an
OpenAI-compatible endpoint, the same one you would use on your own machine. So the image
carries no model and needs no GPU, and the one thing that has to be reachable from inside
it is `AI_BASE_URL`.

Four folders are shared between your machine and the container:

| On your machine | Inside the container | What it holds |
|---|---|---|
| `epub_source/` | `/app/ai-client/epub_source` | Your books, and everything the pipeline writes next to them |
| `.logs/` | `/app/ai-client/.logs` | The transcript of every model call (what was asked, what came back) |
| `.postmortem/` | `/app/ai-client/.postmortem` | What each step left behind, the run ledger, the tickets |
| `.dry-run/` | `/app/ai-client/.dry-run` | The prompts a `--dry-run` would have sent (no model calls were made) |

Everything else in the image is the pipeline's own code. Your `.env` is **not** copied into
the image — it is handed to the container as its environment, so the keys never end up in a
layer of the image.

---

## 2. The short version

```bash
cp .env.example .env          # then edit it: AI_BASE_URL, AI_API_KEY, AI_MODEL
mkdir -p epub_source .logs .postmortem .dry-run   # once, so they are yours and not root's
# put your books (.epub files, one per volume) in epub_source/
docker compose up --build
```

(The `mkdir` matters: Docker creates a mounted folder that does not exist yet as root, and
then the pipeline — which runs as an ordinary user — cannot write into it. `epub_source/`
already ships with the repo; the other three are where the run's own records go.)

That runs the whole pipeline — intake, glossary, character voice, style guide, wiki, the
consistency audit, translation, its QA loop, and polish — one step at a time, each step
assessed before the next one starts. A run over a real series takes hours to days; it is
meant to be left running.

Your results are in `epub_source/` on your machine, in a folder per volume.

Other things you may want:

```bash
docker compose run --rm pipeline --list                       # the steps, in order
docker compose run --rm pipeline --stages=discover,glossary   # only some of them
docker compose run --rm pipeline --dry-run                    # no model calls: prints the prompts it would send
docker compose run --rm --entrypoint bash pipeline            # a shell inside the image
docker compose run --rm --entrypoint bash pipeline -lc "node test/test-env-defaults.js"   # a self-check inside the image
```

The same three most-used ones are npm scripts too: `npm run docker:build`,
`npm run docker:run`, `npm run docker:shell`.

The full offline test suite (`npm test`) is for people working on the code, and it wants a
git checkout — a few of its checks ask git what the project root is, and the image carries
no `.git`. Run it on your machine.

---

## 3. Pointing it at your model server

This is the one thing that bites people. **Inside a container, `localhost` is the
container, not your machine.** A model server running on your laptop is not at
`http://localhost:9200/v1` from in there.

| Your model server runs … | Put this in `.env` |
|---|---|
| somewhere on the internet (OpenAI, OpenRouter, a VPS) | its normal URL, e.g. `https://api.openai.com/v1` |
| on your own machine (llama.cpp, Ollama, LM Studio, vLLM) | `http://host.docker.internal:9200/v1` — the container's name for the machine it is running on |
| in another container on the same Docker host | that container's name or address, e.g. `http://my-model:8080/v1` |

`docker-compose.yml` already maps `host.docker.internal` to your machine, so the second
row works on Linux as well as on Docker Desktop. Two extra settings are usually needed for
a local server: `AI_API_KEY` can be any non-empty value (the pipeline requires one), and
`AI_CONTEXT_WINDOW` must say what your server actually serves.

If your server only accepts connections from your own machine, allow the Docker address too
(`--host 0.0.0.0` for most local servers).

---

## 4. Where the series folder is

`SERIES_LOCATION` is the folder the pipeline reads books from and writes artifacts into.

- **Unset** — or set to `epub_source`, which is what `.env.example` ships with — it is the
  repo's own `epub_source/` folder. Nothing else to configure.
- **In the container it is a path inside the container.** `epub_source` works because
  `docker-compose.yml` mounts your `./epub_source` at exactly that place. An absolute path
  from your machine (`/home/you/books`) does not exist in there unless you mount it at the
  same path.
- The pipeline announces which folder it is using when you did not set one, and the intake
  step stops with a clear message if that folder holds no books.

One honest caveat: the plan of record (`translation-target.json`) records *where* the series
lives. A plan written by a run on your machine is not reused by a run in the container (the
paths differ), so the intake step works the series out again. Pick one of the two and stay
with it.

**If your books live somewhere else** — a folder outside the repo — mount it and name it, in
`docker-compose.yml`:

```yaml
    volumes:
      - /path/on/your/machine/books:/data/books
    environment:
      SERIES_LOCATION: /data/books
```

`/data/books` is the path the pipeline sees; the left-hand side is where they actually are.
An `SERIES_LOCATION` in `.env` that is an absolute path on your machine, with no mount for
it, is the one setting that cannot work in a container — the folder simply is not there.

---

## 5. What is deliberately not in the image

- **Your `.env`** — see §1. It arrives as the container's environment.
- **Your books** — mounted at run time, never baked into a layer (`.dockerignore`).
- **`hooks/`** — the per-machine scripts that start and stop model containers on the
  account owner's machine. They shell out to host tools that do not exist in this image, so
  they are not mounted in. A container run uses the endpoints in `.env` directly, which is
  the simpler and more predictable setup.
- **Run history** — `.logs/`, `.postmortem/`, `.dry-run/`, the token-calibration cache. The
  first two are mounted so you keep them; the calibration cache lives in a Docker volume so
  it survives between runs without landing in the repo.

The container runs as an unprivileged user (or as *your* user id, which is what
`docker-compose.yml` asks for), so the files it writes into `epub_source/` come out owned by
you.

---

## 6. When it does not do what you expected

| What you see | What it means |
|---|---|
| `Missing required environment variable(s): AI_API_KEY` | `.env` is missing, or does not set the key. `cp .env.example .env` and fill it in. |
| `SERIES_LOCATION does not exist or is not accessible: …` | The folder is not mounted, or `.env` names a path that only exists on your machine (§4). |
| `No volumes found in …` | The source folder is empty: put the books in `epub_source/`. |
| `connect ECONNREFUSED` / the run hangs at the first model call | `AI_BASE_URL` is not reachable from inside the container (§3). |
| Files in `epub_source/` owned by root | Your Docker is running the container as root; `docker-compose.yml` asks it not to (`user: "${UID}:${GID}"`). |
| The run finished and nothing appeared on your machine | It was started with `docker run` and no `-v` mount: what the container wrote lives inside it and goes when it is removed. `docker compose` mounts `./epub_source` for you. |
| A step failed and you want to know why | Read `.postmortem/<step>.md` (what the step claims it did vs. what it left) and the transcripts in `.logs/`. |

The pipeline's own explanation of what each step does, and what each setting means, is in
[AGENTS.md](../AGENTS.md) → `docs/architecture.md`, `docs/pipelines.md` and
`docs/environment.md`.
