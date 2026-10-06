# Glossary Validation — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being validated:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the single source of truth for which terms appear in this volume.
2. **The previous glossary** (`glossary-previous.md`) — the terms collected from earlier volumes. *(Absent for the first volume.)*
3. **The amended glossary** (`glossary.md`) — the document under audit.

## Task

Following the system prompt (Glossary Auditor, adversarial mode), audit the amended glossary for:
1. **Completeness** — every term in this volume's source (not already in the previous glossary) is present.
2. **No regressions** — every term from the previous glossary is still present. A term carried forward under a **different source-language spelling** is present: that is a rename, and renames are expected output (this volume's source often writes an old name a new way, and the amend pass reconciles them into one row rather than duplicating the entry).
3. **Consistency** — no term has two different {{TARGET_LANGUAGE}} renderings.
4. **Correctness** — sensible romanization and plausible renderings.
5. **Placement** — each term is in the right section.
6. **Format** — well-formed Markdown tables and an updated "Current through volume" header.

For every finding, provide a concrete fix (exact text and section). Be honest about scope: you verify this volume's completeness against its source; you do not have the earlier volumes' sources. Before calling a carried-forward term missing, check the previous glossary's row against the amended one — if the entry is there under another spelling with the same rendering, report it under **Renamed Entries** (informational), not as a dropped term.

## Output

Write the validation report to `glossary-validation.md` using `writeFile` (complete contents, overwrite), in the exact format from the system prompt.
