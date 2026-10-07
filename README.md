# ai-client

A pipeline that reads a light-novel series and produces what a translation needs before
translation can start — a glossary, a character voice reference, a style guide, a wiki, a
consistency audit — and then the translation itself, chapter by chapter, checked by more
than one model.

It is a **client** of any OpenAI-compatible model endpoint (OpenAI, OpenRouter, or a model
you run yourself). It does not include a model.

## Start here

```bash
cp .env.example .env          # your model endpoint: AI_BASE_URL, AI_API_KEY, AI_MODEL
mkdir -p epub_source .logs .postmortem .dry-run
# drop your books in epub_source/  (.epub files, one per volume — nothing else to arrange)
docker compose up --build     # the whole pipeline, in a container
```

Or without Docker, if you have Node 22.19+ installed:

```bash
npm ci
npm run pipeline
```

Either way: the books go in **`epub_source/`**, and everything the pipeline produces lands
next to them — a folder per volume, holding that volume's glossary, voice reference, style
guide, wiki, translation and the reports that checked it. The four series-level references
and the plan of record land at the top of the same folder.

You do not have to name the volumes, order them, or say what the series is called. The first
step reads the folder, works that out, and writes down what it decided in
`translation-plan.md` before anything else runs. If it is not sure of the order, it stops
rather than guessing.

## If something is not doing what you expected

| Where to look | What it tells you |
|---|---|
| `translation-plan.md` | Which files it decided are volumes, in what order, and what it left out |
| `.postmortem/<step>.md` | What a step claimed to have done, against what it actually left behind |
| `.logs/` | The transcript of every model call in the run |
| `npm run delivery` | Where a stopped run stopped, and what the options are |

## The rest of the documentation

| Read | For |
|---|---|
| [`docs/docker.md`](docs/docker.md) | Running it in a container, and pointing it at a model server on your own machine |
| [`docs/environment.md`](docs/environment.md) | Every setting in `.env`, its default, and what it decides |
| [`docs/pipelines.md`](docs/pipelines.md) | What each of the nine steps actually does |
| [`docs/architecture.md`](docs/architecture.md) | How a task runs: the model calls, the file tools, the QA loops |
| [`AGENTS.md`](AGENTS.md) | The index for working on this codebase |

## Running the tests

```bash
npm test
```

Offline: no model, no network. It runs the whole pipeline against a scripted model server
and then audits what the pipeline *asked* the model, not only what it produced.

## License

MIT — see [LICENSE](LICENSE).
