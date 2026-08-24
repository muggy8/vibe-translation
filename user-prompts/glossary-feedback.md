# Glossary Feedback Application — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being corrected:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before changing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the single source of truth. Use it to verify every fix before applying it.
2. **The previous glossary** (`glossary-previous.md`) — the terms collected from earlier volumes. *(Absent for the first volume.)*
3. **The validation report** (`glossary-validation.md`) — the audit of the current glossary. This is your work order.
4. **The current glossary** (`glossary.md`) — the document to be corrected.

## Task

Following the system prompt (revision mode), apply the validation report's feedback to correct the glossary:

1. **Work through every finding** — missing terms, dropped terms, consistency conflicts, correctness, placement, and format issues.
2. **Add missing terms** in the correct section, rendered consistently with the existing entries (verify against the source).
3. **Restore dropped terms** from the previous glossary.
4. **Resolve consistency conflicts** by using one canonical rendering everywhere.
5. **Preserve everything the report did not flag.** Make the smallest change that resolves each valid finding.
6. **Keep the format intact** — same sections, columns, order, and a correct "Current through volume" header.

## Output

Produce the **complete corrected glossary** in Markdown (the whole file, not just the diff), in the same section/table format as the input. Output **only** the glossary Markdown — no preamble, no commentary.
