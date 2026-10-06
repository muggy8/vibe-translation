# Series intake request

Series location (the folder to work in): {{SERIES_LOCATION}}

{{FIXED_VALUES_BLOCK}}

{{COMMITTED_LAYOUT_BLOCK}}

## What to produce

1. **Stage the series.** For every book you decided is a volume, call
   `stageVolume` to create its volume folder inside the series location and
   put that volume's source file in it.
2. **Write the manifest** to `{{MANIFEST_FILE}}` (inside the series location)
   with `writeFile`: the JSON object described in your instructions, and nothing
   else in that file.
3. **Write the plan** to `{{PLAN_FILE}}` (inside the series location) with
   `writeFile`: the Markdown summary a human will read before the run.

Every text sample you ask for is capped at {{SAMPLE_CHARS}} characters per
call, so sample openings rather than reading whole books.

When both files are written, reply with 2-4 lines summarizing what you decided.
Do not paste the manifest JSON into your reply.
