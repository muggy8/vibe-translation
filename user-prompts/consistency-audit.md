# Consistency Audit Request — {{SOURCE_NAME}}

**Series:** {{SOURCE_NAME}}
**Volumes in series:** {{VOLUME_COUNT}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following **in full** before writing anything (your working
directory is the series root):

1. **`glossary.md`** — the canonical target-language glossary.
2. **`character-voice.md`** — the cumulative character voice reference.
3. **`style-guide.md`** — the cumulative house-style rendering guide.
4. **`shared-wiki.md`** — the living shared wiki (current series state).

Optional supporting context (read only if a finding is ambiguous):
- `translation-target.json` — the volume list.
- any volume folder's `glossary-coverage.md` / `translation-brief.md` if you
  need to check whether a term is actually used in the series.

## Task

Following the system prompt (final consistency auditor), audit the four
artifacts against each other and write the report to
**`consistency-report.md`** in your working directory.

Use the report format from the system prompt exactly. The verdict must be
**PASS** or **FAIL** (FAIL if any HIGH finding exists, or if fewer than four
artifacts were audited).