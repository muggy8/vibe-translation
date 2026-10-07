# `epub_source/` — where your books go

This is the pipeline's **default source folder**: what it uses when `.env` does not
point `SERIES_LOCATION` somewhere else. Put the series here and run — you do not have
to organise it first.

## What to drop in

- **`.epub` files, one per volume.** The intake step (`npx gulp discover`, step 0 of the
  default run) opens them, works out the reading order, the series name and the source
  language, and lays out a folder per volume.
- **or folders you already organised** — one per volume, each holding a `.txt`, `.md` or
  `.epub`.
- That is all. Art books, previews, duplicates and side stories are sorted out by the
  intake step's own reading of the books, and it writes that decision down in
  `translation-plan.md` before any other step runs. If it is not sure of the order, the
  run stops instead of guessing.
- This README is not a book: the intake step ignores it.

## What the pipeline writes here

Everything, next to your books:

- one folder per volume, holding that volume's glossary, character voice reference,
  style guide, wiki, translation and the QA reports;
- at the top of this folder: `translation-target.json` (the plan of record),
  `translation-plan.md` (the same decision in prose), and the four series-level copies —
  `glossary.md`, `character-voice.md`, `style-guide.md`, `shared-wiki.md`.

Keep the series-level copies somewhere else with `SERIES_ARTIFACTS_DIR=<folder>`.

## Is any of this committed?

No. Only this README is tracked: your books are not source code, and neither is pipeline
output (see `.gitignore`). A fresh clone has this folder, empty.

Running it in Docker? This same folder is mounted into the container at
`/app/ai-client/epub_source`, so the books you put here and the results the pipeline writes
here are the ones on your machine — see [docs/docker.md](../docs/docker.md).
