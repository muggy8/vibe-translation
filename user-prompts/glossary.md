# Glossary Amendment — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before writing anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the single source of truth for what appears in this volume.
2. **The previous glossary** (`glossary-previous.md`) — the terms already collected from earlier volumes. *(Absent for the first volume.)*
3. **The new terms** (below) — the terms found in volume {{INSTALLMENT_NUMBER}}'s source that are not yet in the previous glossary.
4. **The research notes** (below) — web research gathered for the new terms.

## New Terms

{{TERMS_LIST}}

## Research Notes

{{RESEARCH_NOTES}}

## Open Glossary Disputes

{{DISPUTES}}

## Task

Following the system prompt, produce the **amended glossary** for {{SOURCE_NAME}}:

1. **Carry forward every existing term** from the previous glossary, unchanged.
2. **Add each new term** in the correct section, rendered per the rules and informed by the research notes. Where the research confirms an established {{TARGET_LANGUAGE}} name, use it.
3. **Reconcile any conflicts** between new and existing terms to a single canonical rendering.
4. **Settle every open dispute** listed above: correct the entry to the rendering the source supports, or keep the canonical rendering and record in its Notes column why it stands. A dispute left unaddressed reappears in every later volume.
5. **Update the "Current through volume" header** to volume {{INSTALLMENT_NUMBER}}.

## Output

Write the complete amended glossary to `glossary.md` using `writeFile` (complete contents, overwrite), in the exact section/table format from the system prompt (using the actual language names as the table headers). Write only the glossary Markdown to the file — no preamble, no commentary, no code fences around the whole thing.
