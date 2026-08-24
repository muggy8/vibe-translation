# Glossary New-Term Extraction — {{SOURCE_NAME}}, Volume {{INSTALLMENT_NUMBER}}

**Series:** {{SOURCE_NAME}}
**Volume being processed:** {{INSTALLMENT_NUMBER}}
**Source language:** {{SOURCE_LANGUAGE}}
**Target language:** {{TARGET_LANGUAGE}}

## Materials Provided

Read the following materials **in full** before extracting anything:

1. **The source text of volume {{INSTALLMENT_NUMBER}}** — the only source you will receive for this volume. The **single source of truth** for which terms appear in volume {{INSTALLMENT_NUMBER}}.
2. **The previous glossary** (`glossary-previous.md`) — the terms already collected from earlier volumes. *(Absent for the first volume.)*

## Task

Following the system prompt, find every term that appears in volume {{INSTALLMENT_NUMBER}}'s source text but is **not already in the previous glossary**. Cover characters (full names), places, items/artifacts, factions/organizations, and key terms/concepts.

For each new term, provide the source-language `term`, a `type`, and a suggested `query` for online research.

## Output

Respond with **only** a JSON array of `{ "term", "type", "query" }` objects — no prose, no markdown fences, no commentary. If there are no new terms, respond with `[]`.
